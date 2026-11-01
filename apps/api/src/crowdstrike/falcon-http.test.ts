import { describe, expect, test } from "bun:test";
import { falconHttpClient } from "./falcon-http";

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
});
