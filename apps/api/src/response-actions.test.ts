import { describe, expect, test } from "bun:test";
import { createResponseActionSender, MAX_RESPONSE_ACTION_ATTEMPTS } from "./response-actions/sender";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const COUNSEL = "k.patel@lawfirm.example";
const SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: its Owner and Ana (an Analyst), a CrowdStrike Integration with Response Actions on
 * (unless `responseActions` is false), a High Case opened by Ana with outside counsel on it as a
 * Guest, and a Response Action sender on a fake Falcon.
 */
async function acme({ responseActions = true }: { responseActions?: boolean } = {}) {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Session = ReturnType<typeof t.session>;

  const add = async (name: string, clientId: string, on: boolean) => {
    const res = await owner.api.integrations.$post({
      json: { name, cloud: "us-1", clientId, clientSecret: "falcon-secret", responseActions: on },
    });
    const body = await res.json();
    if (!("integration" in body)) throw new Error(`Could not add an Integration: ${res.status}`);
    return body.integration.id;
  };
  const integrationId = await add("CrowdStrike — Prod", CLIENT_ID, responseActions);

  const opened = await (await ana.api.cases.$post({ json: { title: "Phishing at Acme", caseType: "phishing", severity: "high" } })).json();
  if (!("case" in opened)) throw new Error("Could not open a Case");
  const number = opened.case.number;
  await owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel" } });
  const guest = await t.guestSignIn(COUNSEL);

  const falcon = fakeFalcon();
  const tenant = falcon.tenant(CLIENT_ID);
  /** A worker's Response Action sender; a new one is a worker started afresh. */
  const sender = () => createResponseActionSender(t.deps, { connect: falcon.connect });
  const worker = sender();

  /** Links an Observable to the Case; returns its id. */
  const link = async (type: "ip" | "domain" | "url" | "email" | "md5" | "sha1" | "sha256", value: string, on = number) => {
    const res = await ana.api.cases[":number"].observables.$post({ param: param(on), json: { type, value } });
    const body = await res.json();
    if (!("observable" in body)) throw new Error(`Could not link ${value}: ${res.status}`);
    return body.observable.id;
  };
  /** Takes a Response Action as `as`; returns the status and body. */
  const take = async (
    as: Session,
    observableId: string,
    { action = "detect", internal, on = number, integration = integrationId }: { action?: "detect" | "prevent"; internal?: boolean; on?: number; integration?: string } = {},
  ) => {
    const res = await as.api.cases[":number"]["response-actions"].$post({
      param: param(on),
      json: { observableId, integrationId: integration, action, internal },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { responseAction?: { id: string; state: string } } };
  };
  const list = async (as: Session) => {
    const body = await (await as.api.cases[":number"]["response-actions"].$get({ param: param(number) })).json();
    if (!("responseActions" in body)) throw new Error("Could not list Response Actions");
    return body;
  };
  const timeline = async (as: Session) => {
    const body = await (await as.api.cases[":number"].timeline.$get({ param: param(number) })).json();
    if (!("entries" in body)) throw new Error("Could not read the Timeline");
    return body.entries;
  };
  const auditLog = async () => {
    const body = await (await owner.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };
  const retry = (as: Session, id: string) => as.api.cases[":number"]["response-actions"][":id"].retry.$post({ param: { ...param(number), id } });

  return { t, owner, ana, guest, number, integrationId, add, tenant, falcon, sender, worker, link, take, list, timeline, auditLog, retry };
}

describe("Taking a Falcon IOC Response Action", () => {
  test("a hash, domain or IP goes to Falcon as a custom IOC once the worker sends it", async () => {
    const a = await acme();
    const hash = await a.link("sha256", SHA256.toUpperCase());
    const domain = await a.link("domain", "invoice-portal[.]biz");
    const ipv4 = await a.link("ip", "185.220.101.4");
    const ipv6 = await a.link("ip", "2001:DB8:0:0::1");
    const md5 = await a.link("md5", "d41d8cd98f00b204e9800998ecf8427e");

    const taken = await a.take(a.ana, hash, { action: "prevent" });
    expect(taken).toMatchObject({
      status: 201,
      body: {
        responseAction: {
          kind: "falcon_ioc",
          state: "pending",
          observable: { id: hash, type: "sha256" },
          target: { type: "sha256", value: SHA256 },
          falcon: { action: "prevent", severity: "high" },
          integration: { id: a.integrationId, name: "CrowdStrike — Prod" },
          requestedBy: { name: "Ana Analyst" },
          sentAt: null,
        },
      },
    });
    for (const id of [domain, ipv4, ipv6]) expect((await a.take(a.ana, id)).status).toBe(201);
    expect((await a.take(a.owner, md5, { action: "prevent" })).status).toBe(201);
    // Queued with the request; nothing reaches Falcon until the worker sends it.
    expect(a.tenant.iocsCreated).toEqual([]);

    await a.worker.tick();
    const description = `C-${a.number}: Phishing at Acme\nhttp://argus.test/cases/${a.number}`;
    const common = { severity: "high" as const, platforms: ["windows", "mac", "linux"], appliedGlobally: true as const, source: "Argus", description };
    expect(a.tenant.iocsCreated).toEqual([
      { type: "sha256", value: SHA256, action: "prevent", ...common },
      { type: "domain", value: "invoice-portal.biz", action: "detect", ...common },
      { type: "ipv4", value: "185.220.101.4", action: "detect", ...common },
      { type: "ipv6", value: "2001:db8::1", action: "detect", ...common },
      { type: "md5", value: "d41d8cd98f00b204e9800998ecf8427e", action: "prevent", ...common },
    ]);
    const { responseActions } = await a.list(a.ana);
    expect(responseActions.map((r) => r.state)).toEqual(["active", "active", "active", "active", "active"]);
    expect(responseActions[0]).toMatchObject({ sentAt: a.t.clock.now().toISOString(), lastError: null });
  });

  test("the IOC's severity follows the Case's Severity", async () => {
    const a = await acme();
    await a.owner.api.cases[":number"].$patch({ param: param(a.number), json: { severity: "critical" } });
    await a.take(a.ana, await a.link("domain", "evil.example"));
    await a.worker.tick();
    expect(a.tenant.iocsCreated.map((i) => i.severity)).toEqual(["critical"]);
  });

  test("Prevent is refused for domains and IPs, and URLs, email addresses and SHA-1 are refused", async () => {
    const a = await acme();
    for (const [type, value] of [
      ["domain", "evil.example"],
      ["ip", "185.220.101.4"],
    ] as const) {
      expect(await a.take(a.ana, await a.link(type, value), { action: "prevent" })).toEqual({
        status: 400,
        body: { error: "Falcon can only Detect a domain or IP; Prevent is for hashes" },
      });
    }
    for (const [type, value, label] of [
      ["url", "https://evil.example/login", "URL"],
      ["email", "ceo@evil.example", "Email"],
      ["sha1", "da39a3ee5e6b4b0d3255bfef95601890afd80709", "SHA-1"],
    ] as const) {
      expect(await a.take(a.ana, await a.link(type, value))).toEqual({
        status: 400,
        body: { error: `Falcon takes no custom IOC for an ${label}` },
      });
    }
    expect((await a.list(a.ana)).responseActions).toEqual([]);
  });

  test("an Observable that isn't linked to the Case can't be sent", async () => {
    const a = await acme();
    const other = await (await a.ana.api.cases.$post({ json: { title: "Other", caseType: "other", severity: "low" } })).json();
    if (!("case" in other)) throw new Error("No Case");
    const elsewhere = await a.link("domain", "evil.example", other.case.number);
    expect(await a.take(a.ana, elsewhere)).toEqual({ status: 404, body: { error: "That Observable isn't linked to this Case" } });
  });

  test("Integrations whose Response Actions are off aren't offered and are refused", async () => {
    const a = await acme({ responseActions: false });
    const on = await a.add("CrowdStrike — EU", "falcon-client-0002", true);
    expect((await a.list(a.ana)).integrations).toEqual([{ id: on, name: "CrowdStrike — EU", provider: "crowdstrike" }]);

    const domain = await a.link("domain", "evil.example");
    expect(await a.take(a.ana, domain)).toEqual({
      status: 400,
      body: { error: "That Integration doesn't take Response Actions; an Admin can turn them on in its settings" },
    });
    expect((await a.take(a.ana, domain, { integration: "no-such-integration" })).status).toBe(400);
    expect((await a.take(a.ana, domain, { integration: on })).status).toBe(201);

    // Turned off before it was sent, it is never sent.
    await a.owner.api.integrations[":id"]["response-actions"].$put({ param: { id: on }, json: { enabled: false } });
    expect((await a.list(a.ana)).integrations).toEqual([]);
    await a.worker.tick();
    expect(a.falcon.tenant("falcon-client-0002").iocsCreated).toEqual([]);
    expect((await a.list(a.ana)).responseActions).toMatchObject([
      { state: "failed", lastError: "Response Actions were turned off for the Integration before this was sent" },
    ]);
  });

  test("Guests can't take Response Actions, and nobody can on a Closed Case", async () => {
    const a = await acme();
    const domain = await a.link("domain", "evil.example");
    expect(await a.take(a.guest, domain)).toMatchObject({ status: 403 });
    expect((await a.list(a.guest)).integrations).toEqual([]);

    await a.ana.api.cases[":number"].close.$post({ param: param(a.number), json: { resolution: "true_positive" } });
    expect(await a.take(a.owner, domain)).toEqual({ status: 409, body: { error: "This Case is Closed and read-only; an Admin can reopen it" } });
    expect((await a.list(a.owner)).responseActions).toEqual([]);
  });
});

describe("Sending Response Actions", () => {
  test("a failed send is retried with backoff and survives a restart", async () => {
    const a = await acme();
    const { body } = await a.take(a.ana, await a.link("domain", "evil.example"));
    a.tenant.failNextIocCalls = 2;

    await a.worker.tick();
    expect(a.tenant.iocsCreated).toEqual([]);
    expect((await a.list(a.ana)).responseActions).toMatchObject([{ state: "pending", lastError: "Calling IOC Management in Falcon failed: 503" }]);
    // Guests are never told why.
    expect((await a.list(a.guest)).responseActions).toMatchObject([{ state: "pending", lastError: null, integration: null }]);

    // Not due for 30 seconds.
    a.t.clock.advance(29_000);
    await a.worker.tick();
    a.t.clock.advance(1_000);
    await a.worker.tick();
    expect(a.tenant.iocsCreated).toEqual([]);

    // The worker restarts: the outbox is in the database, so a new one carries on, a minute later.
    a.t.clock.advance(59_000);
    await a.sender().tick();
    expect(a.tenant.iocsCreated).toEqual([]);
    a.t.clock.advance(1_000);
    await a.sender().tick();
    expect(a.tenant.iocsCreated).toHaveLength(1);
    expect((await a.list(a.ana)).responseActions).toMatchObject([{ id: body.responseAction!.id, state: "active", lastError: null }]);
  });

  test("a send Falcon keeps refusing fails, notifies whoever took it, and can be retried", async () => {
    const a = await acme();
    const { body } = await a.take(a.ana, await a.link("sha256", SHA256), { action: "prevent" });
    const id = body.responseAction!.id;
    a.tenant.refuseIocs = "Creating a custom IOC in Falcon failed: 403 access denied";
    for (let i = 0; i < MAX_RESPONSE_ACTION_ATTEMPTS; i++) {
      await a.worker.tick();
      a.t.clock.advance(60 * 60_000);
    }
    expect((await a.list(a.ana)).responseActions).toMatchObject([
      { id, state: "failed", lastError: "Creating a custom IOC in Falcon failed: 403 access denied", sentAt: null },
    ]);
    const notified = await (await a.ana.api.notifications.$get()).json();
    expect(notified).toMatchObject({
      unread: 1,
      notifications: [{ kind: "response_action_failed", headline: `A Response Action you took on C-${a.number} failed`, section: "observables" }],
    });
    expect((await (await a.owner.api.notifications.$get()).json()).unread).toBe(0);

    // Retried, it is Pending again and goes once Falcon accepts it.
    a.tenant.refuseIocs = null;
    const retried = await a.retry(a.ana, id);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ responseAction: { state: "pending", lastError: null } });
    expect((await a.retry(a.ana, id)).status).toBe(409);
    await a.worker.tick();
    expect(a.tenant.iocsCreated).toHaveLength(1);
    expect((await a.list(a.ana)).responseActions).toMatchObject([{ state: "active" }]);
  });

  test("only a Failed one can be retried, not by Guests, and not on a Closed Case", async () => {
    const a = await acme();
    const { body } = await a.take(a.ana, await a.link("domain", "evil.example"));
    const id = body.responseAction!.id;
    expect(await (await a.retry(a.ana, id)).json()).toEqual({ error: "Only a Failed Response Action can be retried" });
    a.tenant.refuseIocs = "Creating a custom IOC in Falcon failed: 403 access denied";
    for (let i = 0; i < MAX_RESPONSE_ACTION_ATTEMPTS; i++) {
      await a.worker.tick();
      a.t.clock.advance(60 * 60_000);
    }
    expect((await a.retry(a.guest, id)).status).toBe(403);
    expect((await a.retry(a.ana, "no-such-action")).status).toBe(404);
    await a.ana.api.cases[":number"].close.$post({ param: param(a.number), json: { resolution: "true_positive" } });
    expect((await a.retry(a.owner, id)).status).toBe(409);
  });

  test("two workers never send the same Response Action", async () => {
    const a = await acme();
    for (const value of ["one.example", "two.example", "three.example"]) await a.take(a.ana, await a.link("domain", value));
    await Promise.all([a.worker.tick(), a.sender().tick()]);
    expect(a.tenant.iocsCreated.map((i) => i.value).toSorted()).toEqual(["one.example", "three.example", "two.example"]);
  });

  test("a paused Integration's Response Actions wait until it is resumed", async () => {
    const a = await acme();
    await a.owner.api.integrations[":id"].pause.$post({ param: { id: a.integrationId } });
    await a.take(a.ana, await a.link("domain", "evil.example"));
    await a.worker.tick();
    expect(a.tenant.iocsCreated).toEqual([]);
    await a.owner.api.integrations[":id"].resume.$post({ param: { id: a.integrationId } });
    await a.worker.tick();
    expect(a.tenant.iocsCreated).toHaveLength(1);
  });
});

describe("The record of a Response Action", () => {
  test("each state change is on the Timeline and in the Audit Log, without the Integration's name or errors", async () => {
    const a = await acme();
    await a.take(a.ana, await a.link("domain", "evil.example"));
    a.tenant.refuseIocs = "Creating a custom IOC in Falcon failed: 403 access denied";
    for (let i = 0; i < MAX_RESPONSE_ACTION_ATTEMPTS; i++) {
      await a.worker.tick();
      a.t.clock.advance(60 * 60_000);
    }
    a.tenant.refuseIocs = null;
    await a.retry(a.ana, (await a.list(a.ana)).responseActions[0]!.id);
    await a.worker.tick();

    const what = "Domain evil[.]example";
    expect((await a.timeline(a.ana)).map((e) => ({ body: e.body, by: e.recordedBy.name }))).toEqual([
      { body: `Response Action taken by Ana Analyst: send ${what} to CrowdStrike Falcon as a custom IOC (Detect, severity High).`, by: "Ana Analyst" },
      { body: `Response Action failed: Argus could not send ${what} to CrowdStrike Falcon as a custom IOC.`, by: "Ana Analyst" },
      { body: `Response Action retried by Ana Analyst: send ${what} to CrowdStrike Falcon as a custom IOC (Detect, severity High).`, by: "Ana Analyst" },
      { body: `Response Action: Argus sent ${what} to CrowdStrike Falcon as a custom IOC (Detect, severity High).`, by: "Ana Analyst" },
    ]);
    // The Guest sees the same Timeline: it names no Integration and no error.
    expect((await a.timeline(a.guest)).map((e) => e.body)).toEqual((await a.timeline(a.ana)).map((e) => e.body));

    const entries = (await a.auditLog()).filter((e) => e.action.startsWith("response_action.")).toReversed();
    const target = `Falcon custom IOC: ${what}`;
    expect(entries).toMatchObject([
      { action: "response_action.requested", actor: { type: "member", name: "Ana Analyst" }, target, after: "Detect, severity High" },
      { action: "response_action.failed", actor: { type: "system", name: "Argus" }, target, after: "Creating a custom IOC in Falcon failed: 403 access denied" },
      { action: "response_action.retried", actor: { type: "member", name: "Ana Analyst" }, target },
      { action: "response_action.sent", actor: { type: "system", name: "Argus" }, target },
    ]);
  });

  test("Guests see non-Internal Response Actions without the Integration; Internal ones and their Timeline Entries not at all", async () => {
    const a = await acme();
    const shown = await a.take(a.ana, await a.link("domain", "evil.example"));
    const hidden = await a.take(a.ana, await a.link("sha256", SHA256), { internal: true });
    await a.worker.tick();

    const forGuest = await a.list(a.guest);
    expect(forGuest.responseActions).toEqual([expect.objectContaining({ id: shown.body.responseAction!.id, integration: null, lastError: null })]);
    expect((await a.list(a.ana)).responseActions.map((r) => r.id)).toEqual([shown.body.responseAction!.id, hidden.body.responseAction!.id]);
    expect((await a.timeline(a.guest)).some((e) => e.body.includes(SHA256))).toBe(false);
    expect((await a.timeline(a.ana)).filter((e) => e.body.includes(SHA256)).map((e) => e.internal)).toEqual([true, true]);

    // Showing it to Guests shows its Timeline Entries too.
    await a.ana.api.cases[":number"].internal.$put({
      param: param(a.number),
      json: { item: { kind: "response_action", id: hidden.body.responseAction!.id }, internal: false },
    });
    expect((await a.timeline(a.guest)).filter((e) => e.body.includes(SHA256))).toHaveLength(2);
  });

  test("Members' live sockets hear each state change; the Guest's only of what isn't Internal", async () => {
    const a = await acme();
    const domain = await a.link("domain", "evil.example");
    const hash = await a.link("sha256", SHA256);
    const member = await a.t.connect(a.owner);
    const guest = await a.t.connect(a.guest);

    await a.take(a.ana, hash, { internal: true });
    expect(await member.next((m) => m.type === "case")).toEqual({ type: "case", number: a.number });
    await a.worker.tick();
    expect(await member.next((m) => m.type === "case")).toEqual({ type: "case", number: a.number });

    await a.take(a.ana, domain);
    expect(await guest.next((m) => m.type === "case")).toEqual({ type: "case", number: a.number });
    expect(guest.messages.filter((m) => m.type === "case")).toHaveLength(1);
  });

  test("the Case Report includes Response Actions, and the Guest-safe one leaves out Internal ones and Integration details", async () => {
    const a = await acme();
    await a.take(a.ana, await a.link("domain", "evil.example"));
    await a.take(a.ana, await a.link("sha256", SHA256), { action: "prevent", internal: true });
    await a.worker.tick();
    const report = async (variant: "complete" | "guest_safe") =>
      (await a.owner.api.cases[":number"].report.$get({ param: param(a.number), query: { variant, format: "markdown" } })).text();

    const complete = await report("complete");
    expect(complete).toContain("## Response Actions");
    expect(complete).toContain("evil[.]example");
    expect(complete).toContain(SHA256);
    expect(complete).toContain("CrowdStrike — Prod");
    expect(complete).toContain(`Active, sent ${a.t.clock.now().toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(complete).not.toMatch(/currently blocked/i);

    const guestSafe = await report("guest_safe");
    const section = guestSafe.slice(guestSafe.indexOf("## Response Actions"), guestSafe.indexOf("## Evidence"));
    expect(section).toContain("Falcon custom IOC:** `Domain evil[.]example`");
    expect(section).not.toContain(SHA256);
    expect(guestSafe).not.toContain("CrowdStrike — Prod");
  });
});
