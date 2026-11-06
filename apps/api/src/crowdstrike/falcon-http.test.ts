import { describe, expect, test } from "bun:test";
import { falconHttpClient, readComments } from "./falcon-http";

/** A Falcon API that answers from `routes`, recording each request. */
function stubFalcon(routes: Record<string, (req: Request) => Response>) {
  const requests: Request[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    requests.push(req);
    const url = new URL(req.url);
    const handler = routes[`${req.method} ${url.origin}${url.pathname}`];
    return handler ? handler(req) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { requests, fetchImpl };
}

const connection = { cloud: "eu-1" as const, credentials: { clientId: "id", clientSecret: "secret" }, appId: "argusabc" };
const token = () => Response.json({ access_token: "access", expires_in: 1799 });
const discovery = () =>
  Response.json({
    resources: [
      {
        dataFeedURL: "https://firehose.eu-1.crowdstrike.com/sensors/entities/datafeed/v1/0?appId=argusabc",
        sessionToken: { token: "session-token", expiration: "2026-01-01T09:30:00Z" },
        refreshActiveSessionURL: "https://api.eu-1.crowdstrike.com/sensors/entities/datafeed-actions/v1/0?appId=argusabc&action_name=refresh_active_stream_session",
        refreshActiveSessionInterval: 1800,
      },
    ],
  });

describe("The Falcon API client", () => {
  test("signs in, opens the stream and reads newline-delimited events from the given offset", async () => {
    const lines = [
      { metadata: { offset: 7, eventType: "EppDetectionSummaryEvent", eventCreationTime: 1767258000000 }, event: { CompositeId: "a" } },
      { metadata: { offset: 8, eventType: "AuthActivityAuditEvent" }, event: {} },
    ];
    const body = `${JSON.stringify(lines[0])}\n\n${JSON.stringify(lines[1]).slice(0, 20)}`;
    const rest = `${JSON.stringify(lines[1]).slice(20)}\n`;
    const { requests, fetchImpl } = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "GET https://api.eu-1.crowdstrike.com/sensors/entities/datafeed/v2": discovery,
      "GET https://firehose.eu-1.crowdstrike.com/sensors/entities/datafeed/v1/0": () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.enqueue(new TextEncoder().encode(rest));
              controller.close();
            },
          }),
        ),
    });
    const client = falconHttpClient(connection, fetchImpl);
    const session = await client.openStream();
    expect(session).toMatchObject({ token: "session-token", refreshIntervalMs: 1_800_000 });

    const events = [];
    for await (const e of client.consume(session, 7, new AbortController().signal)) events.push(e);
    expect(events).toEqual([
      { offset: 7, eventType: "EppDetectionSummaryEvent", createdAt: new Date(1767258000000), event: { CompositeId: "a" } },
      { offset: 8, eventType: "AuthActivityAuditEvent", createdAt: null, event: {} },
    ]);
    const feed = requests.at(-1)!;
    expect(new URL(feed.url).searchParams.get("offset")).toBe("7");
    expect(new URL(feed.url).searchParams.get("appId")).toBe("argusabc");
    expect(feed.headers.get("authorization")).toBe("Token session-token");
    expect(requests.filter((r) => r.url.endsWith("/oauth2/token"))).toHaveLength(1);
  });

  test("refreshes the session at the URL Falcon gave", async () => {
    const { requests, fetchImpl } = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "GET https://api.eu-1.crowdstrike.com/sensors/entities/datafeed/v2": discovery,
      "POST https://api.eu-1.crowdstrike.com/sensors/entities/datafeed-actions/v1/0": () => Response.json({ resources: [] }),
    });
    const client = falconHttpClient(connection, fetchImpl);
    await client.refreshStream(await client.openStream());
    expect(requests.at(-1)!.headers.get("authorization")).toBe("Bearer access");
  });

  test("reports refused credentials and a missing Event Stream", async () => {
    const refused = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": () => Response.json({ errors: [{ message: "access denied, invalid client" }] }, { status: 401 }),
    });
    await expect(falconHttpClient(connection, refused.fetchImpl).openStream()).rejects.toThrow("Signing in to the Falcon API failed: 401 access denied, invalid client");

    const none = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "GET https://api.eu-1.crowdstrike.com/sensors/entities/datafeed/v2": () => Response.json({ resources: [] }),
    });
    await expect(falconHttpClient(connection, none.fetchImpl).openStream()).rejects.toThrow(/Event Streams enabled/);
  });

  test("updates Alerts with Falcon's action parameters", async () => {
    const { requests, fetchImpl } = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "PATCH https://api.eu-1.crowdstrike.com/alerts/entities/alerts/v3": () => Response.json({ resources: [] }),
    });
    const client = falconHttpClient(connection, fetchImpl);
    await client.updateAlerts(["a", "b"], { status: "in_progress", comment: "Attached to Argus Case C-1" });
    await client.updateAlerts(["a"], { assignTo: "uuid-1" });
    await client.updateAlerts(["a"], { assignTo: null });
    const patches = requests.filter((r) => r.method === "PATCH");
    expect(patches[0]!.headers.get("authorization")).toBe("Bearer access");
    expect(await Promise.all(patches.map((r) => r.json()))).toEqual([
      {
        composite_ids: ["a", "b"],
        action_parameters: [
          { name: "update_status", value: "in_progress" },
          { name: "append_comment", value: "Attached to Argus Case C-1" },
        ],
      },
      { composite_ids: ["a"], action_parameters: [{ name: "assign_to_uuid", value: "uuid-1" }] },
      { composite_ids: ["a"], action_parameters: [{ name: "unassign", value: "" }] },
    ]);

    const refused = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "PATCH https://api.eu-1.crowdstrike.com/alerts/entities/alerts/v3": () => Response.json({ errors: [{ message: "access denied" }] }, { status: 403 }),
    });
    await expect(falconHttpClient(connection, refused.fetchImpl).updateAlerts(["a"], { status: "closed" })).rejects.toThrow(
      "Updating Alerts in Falcon failed: 403 access denied",
    );
  });

  test("finds a Falcon user by login email, escaping it for FQL", async () => {
    const { requests, fetchImpl } = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "GET https://api.eu-1.crowdstrike.com/user-management/queries/users/v1": (req) =>
        Response.json({ resources: new URL(req.url).searchParams.get("filter") === "uid:'ana@acme.example'" ? ["uuid-ana"] : [] }),
    });
    const client = falconHttpClient(connection, fetchImpl);
    expect(await client.findUser("ana@acme.example")).toBe("uuid-ana");
    expect(await client.findUser("o'brien@acme.example")).toBeNull();
    expect(new URL(requests.at(-1)!.url).searchParams.get("filter")).toBe("uid:'o\\'brien@acme.example'");
  });

  test("reads an Alert's comments, oldest first, giving those without an id one that stays the same", async () => {
    const alert = {
      composite_id: "a",
      comments: [
        { id: "c-2", value: "Reimaging.", created_by: "mlee@acme.example", timestamp: "2026-01-01T10:00:00Z" },
        { value: "Isolated.", user_name: "jsmith@acme.example", timestamp: 1767258000 },
        { value: "   " },
        "not a comment",
      ],
    };
    const { requests, fetchImpl } = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "POST https://api.eu-1.crowdstrike.com/alerts/entities/alerts/v2": () => Response.json({ resources: [alert] }),
    });
    const comments = await falconHttpClient(connection, fetchImpl).alertComments("a");
    expect(await requests.at(-1)!.json()).toEqual({ composite_ids: ["a"] });
    expect(comments).toEqual([
      { id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), author: "jsmith@acme.example", body: "Isolated.", createdAt: new Date(1767258000 * 1000) },
      { id: "c-2", author: "mlee@acme.example", body: "Reimaging.", createdAt: new Date("2026-01-01T10:00:00Z") },
    ]);
    expect(readComments(alert)[0]!.id).toBe(comments[0]!.id);
    expect(readComments({})).toEqual([]);

    const refused = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "POST https://api.eu-1.crowdstrike.com/alerts/entities/alerts/v2": () => Response.json({ errors: [{ message: "access denied" }] }, { status: 403 }),
    });
    await expect(falconHttpClient(connection, refused.fetchImpl).alertComments("a")).rejects.toThrow(
      "Reading an Alert's comments from Falcon failed: 403 access denied",
    );
  });

  test("looks up, creates and deletes custom IOCs", async () => {
    const ioc = {
      type: "sha256" as const,
      value: "a".repeat(64),
      action: "prevent" as const,
      severity: "high" as const,
      platforms: ["windows", "mac", "linux"],
      appliedGlobally: true as const,
      source: "Argus",
      description: "C-7: Phishing at Acme\nhttp://argus.test/cases/7",
    };
    const { requests, fetchImpl } = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "GET https://api.eu-1.crowdstrike.com/iocs/combined/indicator/v1": (req) =>
        Response.json({
          resources: new URL(req.url).searchParams.get("filter") === `type:'sha256'+value:'${"a".repeat(64)}'`
            ? [{ id: "ioc-1", ...ioc, applied_globally: true, severity: "HIGH" }]
            : [],
        }),
      "POST https://api.eu-1.crowdstrike.com/iocs/entities/indicators/v1": () => Response.json({ resources: [{ id: "ioc-2" }], errors: null }),
      "DELETE https://api.eu-1.crowdstrike.com/iocs/entities/indicators/v1": () => Response.json({ resources: ["ioc-2"] }),
    });
    const client = falconHttpClient(connection, fetchImpl);
    expect(await client.findIoc("sha256", "a".repeat(64))).toEqual({ id: "ioc-1", ...ioc });
    expect(await client.findIoc("domain", "o'brien.example")).toBeNull();
    expect(new URL(requests.at(-1)!.url).searchParams.get("filter")).toBe("type:'domain'+value:'o\\'brien.example'");

    expect(await client.createIoc(ioc)).toBe("ioc-2");
    expect(await requests.at(-1)!.json()).toEqual({
      indicators: [
        {
          type: "sha256",
          value: "a".repeat(64),
          action: "prevent",
          severity: "high",
          platforms: ["windows", "mac", "linux"],
          applied_globally: true,
          source: "Argus",
          description: "C-7: Phishing at Acme\nhttp://argus.test/cases/7",
        },
      ],
    });

    expect(await client.deleteIoc("ioc-2")).toBe(true);
    expect(requests.at(-1)!.method).toBe("DELETE");
    expect(new URL(requests.at(-1)!.url).searchParams.get("ids")).toBe("ioc-2");

    // Already gone from Falcon: nothing to delete, and that is not a failure.
    const gone = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "DELETE https://api.eu-1.crowdstrike.com/iocs/entities/indicators/v1": () => Response.json({ errors: [{ message: "not found" }] }, { status: 404 }),
    });
    expect(await falconHttpClient(connection, gone.fetchImpl).deleteIoc("ioc-9")).toBe(false);

    const refused = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "POST https://api.eu-1.crowdstrike.com/iocs/entities/indicators/v1": () =>
        Response.json({ resources: [], errors: [{ message: "Prevent is not supported for domain" }] }),
    });
    await expect(falconHttpClient(connection, refused.fetchImpl).createIoc(ioc)).rejects.toThrow(
      "Creating a custom IOC in Falcon failed: Prevent is not supported for domain",
    );
  });
});
