import { describe, expect, test } from "bun:test";
import { FalconScopeMissing } from "./falcon";
import { executionOutcome, falconHttpClient, readComments, readExecution, readWorkflow } from "./falcon-http";

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

  test("reads hosts by aid, naming their host groups, and leaves out those Falcon doesn't know", async () => {
    const device = {
      device_id: "8F1C2B3A4D5E6F708192A3B4C5D6E7F8",
      hostname: "FIN-LT-0231",
      platform_name: "Windows",
      os_version: "Windows 11",
      agent_version: "7.18.18403.0",
      reduced_functionality_mode: "no",
      provision_status: "Provisioned",
      first_seen: "2025-03-02T08:15:00Z",
      last_seen: "2026-01-01T08:55:00Z",
      local_ip: "10.20.4.31",
      external_ip: "203.0.113.24",
      mac_address: "3c-52-82-1a-9b-04",
      machine_domain: "ACME",
      ou: ["Finance", "Laptops"],
      site_name: "Leeds",
      serial_number: "PF3XK2LM",
      system_manufacturer: "LENOVO",
      system_product_name: "ThinkPad T14 Gen 4",
      last_login_user: "ACME\\d.howe",
      groups: ["g1", "g2"],
      tags: ["FalconGroupingTags/finance"],
      status: "contained",
    };
    const { requests, fetchImpl } = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      // One of the two is unknown: Falcon says 404 and returns the other.
      "POST https://api.eu-1.crowdstrike.com/devices/entities/devices/v2": () =>
        Response.json({ resources: [device], errors: [{ code: 404, message: "Device not found" }] }, { status: 404 }),
      "GET https://api.eu-1.crowdstrike.com/devices/entities/host-groups/v1": () => Response.json({ resources: [{ id: "g1", name: "Finance laptops" }] }),
    });
    const hosts = await falconHttpClient(connection, fetchImpl).hosts(["8f1c2b3a4d5e6f708192a3b4c5d6e7f8", "0123456789abcdef0123456789abcdef"]);
    expect(await requests[1]!.json()).toEqual({ ids: ["8f1c2b3a4d5e6f708192a3b4c5d6e7f8", "0123456789abcdef0123456789abcdef"] });
    expect(new URL(requests[2]!.url).searchParams.getAll("ids")).toEqual(["g1", "g2"]);
    expect(hosts).toEqual([
      {
        deviceId: "8f1c2b3a4d5e6f708192a3b4c5d6e7f8",
        hostname: "FIN-LT-0231",
        platform: "Windows",
        osVersion: "Windows 11",
        sensorVersion: "7.18.18403.0",
        sensorStatus: "Normal",
        firstSeen: "2025-03-02T08:15:00.000Z",
        lastSeen: "2026-01-01T08:55:00.000Z",
        localIp: "10.20.4.31",
        externalIp: "203.0.113.24",
        macAddress: "3c-52-82-1a-9b-04",
        domain: "ACME",
        ou: ["Finance", "Laptops"],
        site: "Leeds",
        serialNumber: "PF3XK2LM",
        manufacturer: "LENOVO",
        model: "ThinkPad T14 Gen 4",
        lastLoggedOnUser: "ACME\\d.howe",
        hostGroups: ["Finance laptops", "g2"],
        tags: ["FalconGroupingTags/finance"],
        containment: "contained",
      },
    ]);
  });

  test("a hosts read refused for want of a scope says so", async () => {
    const { fetchImpl } = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "POST https://api.eu-1.crowdstrike.com/devices/entities/devices/v2": () =>
        Response.json({ errors: [{ code: 403, message: "access denied, authorization failed" }] }, { status: 403 }),
    });
    const read = falconHttpClient(connection, fetchImpl).hosts(["8f1c2b3a4d5e6f708192a3b4c5d6e7f8"]);
    await expect(read).rejects.toBeInstanceOf(FalconScopeMissing);
  });

  test("contains a device and lifts its containment by aid; refused for want of Hosts: Write says so", async () => {
    const { requests, fetchImpl } = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "POST https://api.eu-1.crowdstrike.com/devices/entities/devices-actions/v2": () => Response.json({ resources: [{ id: "8f1c" }] }, { status: 202 }),
    });
    const client = falconHttpClient(connection, fetchImpl);
    await client.containHost("8f1c2b3a4d5e6f708192a3b4c5d6e7f8");
    await client.liftContainment("8f1c2b3a4d5e6f708192a3b4c5d6e7f8");
    expect(requests.slice(1).map((r) => new URL(r.url).searchParams.get("action_name"))).toEqual(["contain", "lift_containment"]);
    expect(await requests[2]!.json()).toEqual({ ids: ["8f1c2b3a4d5e6f708192a3b4c5d6e7f8"] });

    const refused = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "POST https://api.eu-1.crowdstrike.com/devices/entities/devices-actions/v2": () => Response.json({ errors: [{ code: 403, message: "access denied" }] }, { status: 403 }),
    });
    const lift = falconHttpClient(connection, refused.fetchImpl).liftContainment("8f1c2b3a4d5e6f708192a3b4c5d6e7f8");
    await expect(lift).rejects.toThrow(new FalconScopeMissing("Lifting containment in Falcon failed: the API client lacks the Hosts: Write scope"));
  });

  test("finds hosts by hostname, page by page, as lower-case aids", async () => {
    const pages = [
      { resources: ["8F1C2B3A4D5E6F708192A3B4C5D6E7F8"], meta: { pagination: { offset: 0, limit: 100, total: 2 } } },
      { resources: ["0123456789abcdef0123456789abcdef"], meta: { pagination: { offset: 1, limit: 100, total: 2 } } },
    ];
    const { requests, fetchImpl } = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "GET https://api.eu-1.crowdstrike.com/devices/queries/devices/v1": () => Response.json(pages.shift()),
    });
    const found = await falconHttpClient(connection, fetchImpl).findHosts("FIN-LT-0231's");
    expect(found).toEqual(["8f1c2b3a4d5e6f708192a3b4c5d6e7f8", "0123456789abcdef0123456789abcdef"]);
    const queries = requests.slice(1).map((r) => new URL(r.url).searchParams);
    expect(queries.map((q) => q.get("filter"))).toEqual(["hostname:'FIN-LT-0231\\'s'", "hostname:'FIN-LT-0231\\'s'"]);
    expect(queries.map((q) => q.get("offset"))).toEqual(["0", "1"]);
  });

  test("a hostname search with no match finds nothing, and one refused for want of a scope says so", async () => {
    const empty = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "GET https://api.eu-1.crowdstrike.com/devices/queries/devices/v1": () => Response.json({ resources: [], meta: { pagination: { total: 0 } } }),
    });
    expect(await falconHttpClient(connection, empty.fetchImpl).findHosts("FIN-LT-0231")).toEqual([]);

    const refused = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      "GET https://api.eu-1.crowdstrike.com/devices/queries/devices/v1": () =>
        Response.json({ errors: [{ code: 403, message: "access denied, authorization failed" }] }, { status: 403 }),
    });
    await expect(falconHttpClient(connection, refused.fetchImpl).findHosts("FIN-LT-0231")).rejects.toBeInstanceOf(FalconScopeMissing);
  });

  const GRAPHQL = "POST https://api.eu-1.crowdstrike.com/identity-protection/combined/graphql/v1";
  const node = {
    entityId: "e3a1c9f0-dana",
    primaryDisplayName: "Dana Howe",
    secondaryDisplayName: "ACME.LOCAL\\d.howe",
    type: "USER",
    riskScore: 0.62,
    riskScoreSeverity: "MEDIUM",
    watched: true,
    mostRecentActivity: "2026-01-01T08:55:00Z",
    riskFactors: [
      { type: "STALE_ACCOUNT", severity: "MEDIUM" },
      { type: "PASSWORD_NEVER_EXPIRES", severity: "LOW" },
    ],
    roles: [{ type: "DomainAdminsRole" }],
    emailAddresses: ["dana.howe@acme.example"],
    accounts: [
      {
        domain: "ACME.LOCAL",
        samAccountName: "d.howe",
        upn: "d.howe@acme.example",
        ou: "ACME.LOCAL/Finance/Users",
        department: "Finance",
        title: "Controller",
        enabled: true,
        lockoutTime: null,
        passwordAttributes: { lastChange: "2025-11-02T09:00:00Z", mayExpire: false },
      },
    ],
    associations: [
      { bindingType: "OWNERSHIP", entity: { type: "ENDPOINT", primaryDisplayName: "FIN-LT-0231" } },
      { bindingType: "MEMBER_OF", entity: { type: "GROUP", primaryDisplayName: "Domain Admins" } },
    ],
  };

  test("reads identities by entity ID from Identity Protection's GraphQL API", async () => {
    const { requests, fetchImpl } = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      [GRAPHQL]: () => Response.json({ data: { entities: { nodes: [node] } } }),
    });
    const found = await falconHttpClient(connection, fetchImpl).identities(["e3a1c9f0-dana"]);
    const sent = (await requests[1]!.json()) as { query: string; variables: unknown };
    expect(sent.query).toContain("entityIds: $values");
    expect(sent.variables).toEqual({ values: ["e3a1c9f0-dana"] });
    expect(found).toEqual([
      {
        entityId: "e3a1c9f0-dana",
        displayName: "Dana Howe",
        upn: "d.howe@acme.example",
        samAccountName: "d.howe",
        riskScore: 0.62,
        riskSeverity: "MEDIUM",
        riskFactors: [
          { type: "STALE_ACCOUNT", severity: "MEDIUM" },
          { type: "PASSWORD_NEVER_EXPIRES", severity: "LOW" },
        ],
        enabled: true,
        lockedOut: false,
        stale: true,
        privileged: true,
        privilegedGroups: ["Domain Admins"],
        watched: true,
        passwordLastSet: "2025-11-02T09:00:00.000Z",
        passwordNeverExpires: true,
        lastActivity: "2026-01-01T08:55:00.000Z",
        email: "dana.howe@acme.example",
        department: "Finance",
        title: "Controller",
        domain: "ACME.LOCAL",
        ou: "ACME.LOCAL/Finance/Users",
        endpoints: ["FIN-LT-0231"],
      },
    ]);
  });

  test("finds identities by UPN or email, and by SAM name within a domain given by its DNS or NetBIOS name", async () => {
    const lab = { ...node, entityId: "7b20d4aa-dana-lab", accounts: [{ ...node.accounts[0], domain: "LAB.ACME.LOCAL" }] };
    const { requests, fetchImpl } = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      [GRAPHQL]: () => Response.json({ data: { entities: { nodes: [node, lab] } } }),
    });
    const client = falconHttpClient(connection, fetchImpl);
    expect(await client.findIdentities({ upn: "d.howe@acme.example" })).toEqual(["e3a1c9f0-dana", "7b20d4aa-dana-lab"]);
    expect(await client.findIdentities({ samAccountName: "d.howe" })).toEqual(["e3a1c9f0-dana", "7b20d4aa-dana-lab"]);
    expect(await client.findIdentities({ domain: "LAB", samAccountName: "d.howe" })).toEqual(["7b20d4aa-dana-lab"]);
    expect(await client.findIdentities({ domain: "acme.local", samAccountName: "d.howe" })).toEqual(["e3a1c9f0-dana"]);
    const queries = await Promise.all(requests.filter((r) => r.url.includes("graphql")).map(async (r) => ((await r.json()) as { query: string }).query));
    expect(queries.map((q) => q.match(/entities\(types: \[USER\], (\w+):/)?.[1])).toEqual([
      "userPrincipalNames",
      "emailAddresses",
      "samAccountNames",
      "samAccountNames",
      "samAccountNames",
    ]);
  });

  test("an identity call refused, for want of the scope or the subscription, says so; GraphQL errors fail it", async () => {
    const refused = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      [GRAPHQL]: () => Response.json({ errors: [{ code: 403, message: "access denied, authorization failed" }] }, { status: 403 }),
    });
    await expect(falconHttpClient(connection, refused.fetchImpl).identities(["x"])).rejects.toBeInstanceOf(FalconScopeMissing);
    await expect(falconHttpClient(connection, refused.fetchImpl).findIdentities({ samAccountName: "d.howe" })).rejects.toBeInstanceOf(FalconScopeMissing);
    const broken = stubFalcon({
      "POST https://api.eu-1.crowdstrike.com/oauth2/token": token,
      [GRAPHQL]: () => Response.json({ data: null, errors: [{ message: "Cannot query field" }] }),
    });
    await expect(falconHttpClient(connection, broken.fetchImpl).identities(["x"])).rejects.toThrow("Reading identities from Falcon failed: Cannot query field");
  });
});

/** A workflow definition as Falcon Fusion SOAR lists it. */
const definition = (id: string, trigger: Record<string, unknown>) => ({ id, name: `Workflow ${id}`, description: "Does things", enabled: true, trigger });

describe("Falcon Fusion SOAR workflows", () => {
  const BASE = "https://api.eu-1.crowdstrike.com";

  test("lists every definition, page by page, with the inputs an on-demand trigger declares", async () => {
    const { requests, fetchImpl } = stubFalcon({
      [`POST ${BASE}/oauth2/token`]: token,
      [`GET ${BASE}/workflows/combined/definitions/v1`]: (req) =>
        new URL(req.url).searchParams.get("offset") === "0"
          ? Response.json({
              resources: [
                definition("a", {
                  type: "On demand",
                  parameters: {
                    type: "object",
                    required: ["host"],
                    properties: {
                      host: { type: "string", title: "Host", description: "Which host" },
                      priority: { type: "string", enum: ["low", "high"] },
                      count: { type: ["integer", "null"] },
                      dryRun: { type: "boolean" },
                      extra: { type: "object" },
                    },
                  },
                }),
              ],
              meta: { pagination: { total: 2 } },
            })
          : Response.json({ resources: [definition("b", { type: "Scheduled" })], meta: { pagination: { total: 2 } } }),
    });
    const workflows = await falconHttpClient(connection, fetchImpl).workflows();
    expect(workflows).toEqual([
      {
        id: "a",
        name: "Workflow a",
        description: "Does things",
        enabled: true,
        onDemand: true,
        inputs: [
          { name: "host", label: "Host", type: "string", required: true, description: "Which host", options: null },
          { name: "priority", label: "priority", type: "string", required: false, description: null, options: ["low", "high"] },
          { name: "count", label: "count", type: "integer", required: false, description: null, options: null },
          { name: "dryRun", label: "dryRun", type: "boolean", required: false, description: null, options: null },
        ],
      },
      { id: "b", name: "Workflow b", description: "Does things", enabled: true, onDemand: false, inputs: [] },
    ]);
    expect(requests.filter((r) => r.url.includes("/workflows/")).map((r) => new URL(r.url).searchParams.get("offset"))).toEqual(["0", "1"]);
  });

  test("runs a definition with its inputs and returns the execution's id", async () => {
    const { requests, fetchImpl } = stubFalcon({
      [`POST ${BASE}/oauth2/token`]: token,
      [`POST ${BASE}/workflows/entities/execute/v1`]: () => Response.json({ resources: ["exec-1"] }),
    });
    expect(await falconHttpClient(connection, fetchImpl).executeWorkflow("def-1", { host: "FIN-LT-0231", dryRun: true })).toBe("exec-1");
    const sent = requests.at(-1)!;
    expect(new URL(sent.url).searchParams.get("definition_id")).toBe("def-1");
    expect(await sent.json()).toEqual({ host: "FIN-LT-0231", dryRun: true });
  });

  test("says which scope is missing when Falcon refuses", async () => {
    const { fetchImpl } = stubFalcon({
      [`POST ${BASE}/oauth2/token`]: token,
      [`GET ${BASE}/workflows/combined/definitions/v1`]: () => Response.json({ errors: [{ message: "access denied" }] }, { status: 403 }),
      [`POST ${BASE}/workflows/entities/execute/v1`]: () => Response.json({ errors: [{ message: "access denied" }] }, { status: 403 }),
    });
    const client = falconHttpClient(connection, fetchImpl);
    await expect(client.workflows()).rejects.toBeInstanceOf(FalconScopeMissing);
    await expect(client.executeWorkflow("def-1", {})).rejects.toThrow("Workflow: Write");
  });

  test("reads executions' results, mapping Falcon's status to an outcome", async () => {
    const { fetchImpl } = stubFalcon({
      [`POST ${BASE}/oauth2/token`]: token,
      [`GET ${BASE}/workflows/entities/execution-results/v1`]: () =>
        Response.json({
          resources: [
            {
              execution_id: "exec-1",
              status: "Completed",
              start_timestamp: "2026-01-01T09:00:00Z",
              end_timestamp: "2026-01-01T09:00:05Z",
              activities: [{ name: "Contain host", status: "Completed" }, { node_id: "n2", status: "Skipped" }],
              output_data: { ticket: "INC-1" },
            },
          ],
        }),
    });
    expect(await falconHttpClient(connection, fetchImpl).workflowExecutions(["exec-1", "unknown"])).toEqual([
      {
        id: "exec-1",
        outcome: "completed",
        status: "Completed",
        startedAt: new Date("2026-01-01T09:00:00Z"),
        endedAt: new Date("2026-01-01T09:00:05Z"),
        activities: [
          { name: "Contain host", status: "Completed" },
          { name: "n2", status: "Skipped" },
        ],
        output: { ticket: "INC-1" },
        error: null,
      },
    ]);
    expect([executionOutcome("In progress"), executionOutcome("FAILED"), executionOutcome("canceled"), executionOutcome("Pending")]).toEqual(["running", "failed", "cancelled", "running"]);
    expect(readExecution({ status: "Completed" })).toBeNull();
    expect(readWorkflow({ id: "x", name: "Off", enabled: false, trigger: { name: "on_demand" } })).toMatchObject({ enabled: false, onDemand: true, inputs: [] });
  });
});
