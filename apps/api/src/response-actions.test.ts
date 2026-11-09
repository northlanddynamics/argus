import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
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
  const retry = (as: Session, id: string, on = number) => as.api.cases[":number"]["response-actions"][":id"].retry.$post({ param: { ...param(on), id } });
  const dismiss = async (as: Session, id: string, on = number) => {
    const res = await as.api.cases[":number"]["response-actions"][":id"].dismiss.$post({ param: { ...param(on), id } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  /** Removes Response Action `id` as `as`; returns the status and body. */
  const remove = async (as: Session, id: string, { on = number, confirmRelying }: { on?: number; confirmRelying?: boolean } = {}) => {
    const res = await as.api.cases[":number"]["response-actions"][":id"].remove.$post({ param: { ...param(on), id }, json: { confirmRelying } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { responseAction?: { id: string; state: string } } };
  };
  /** Opens another Case as Ana; returns its number. */
  const open = async (title: string) => {
    const body = await (await ana.api.cases.$post({ json: { title, caseType: "phishing", severity: "medium" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    return body.case.number;
  };
  const listOn = async (as: Session, on: number) => {
    const body = await (await as.api.cases[":number"]["response-actions"].$get({ param: param(on) })).json();
    if (!("responseActions" in body)) throw new Error("Could not list Response Actions");
    return body.responseActions;
  };

  /** Takes several at once as `as`; returns the status and body. */
  const takeMany = async (
    as: Session,
    observableIds: string[],
    {
      action = "detect",
      integrations = [integrationId],
      confirmIgnored,
      internal,
      on = number,
    }: { action?: "detect" | "prevent"; integrations?: string[]; confirmIgnored?: boolean; internal?: boolean; on?: number } = {},
  ) => {
    const res = await as.api.cases[":number"]["response-actions"].bulk.$post({
      param: param(on),
      json: { observableIds, integrationIds: integrations, action, confirmIgnored, internal },
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown> & {
        responseActions?: { id: string; state: string; observable: { value: string }; integration: { id: string } | null }[];
        skipped?: { observable: { id: string; type: string; value: string }; provider: string; reason: string }[];
      },
    };
  };
  /** Observable `id`'s page, as `as` sees it. */
  const page = async (as: Session, id: string) => {
    const body = await (await as.api.observables[":id"].$get({ param: { id } })).json();
    if (!("item" in body)) throw new Error("Could not open the Observable's page");
    return body.item;
  };
  const ignore = (id: string) => owner.api.observables[":id"].ignored.$put({ param: { id } });

  return {
    t,
    owner,
    ana,
    guest,
    number,
    integrationId,
    add,
    tenant,
    falcon,
    sender,
    worker,
    link,
    take,
    takeMany,
    page,
    ignore,
    list,
    timeline,
    auditLog,
    retry,
    dismiss,
    remove,
    open,
    listOn,
  };
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

  test("an Integration's defaults set the IOC's severity and platforms, and whether it starts Internal", async () => {
    const a = await acme();
    const set = await a.owner.api.integrations[":id"]["response-action-defaults"].$put({
      param: { id: a.integrationId },
      json: { severity: "low", platforms: ["linux", "windows"], internal: true },
    });
    expect(set.status).toBe(200);
    expect((await a.list(a.ana)).integrations[0]!.defaults).toEqual({ severity: "low", platforms: ["windows", "linux"], internal: true });

    const domain = await a.link("domain", "evil.example");
    const hash = await a.link("sha256", SHA256);
    expect((await a.take(a.ana, domain)).body.responseAction).toMatchObject({ falcon: { action: "detect", severity: "low" }, internal: true });
    // Asked for explicitly, it is shown to Guests after all.
    expect((await a.take(a.ana, hash, { action: "prevent", internal: false })).body.responseAction).toMatchObject({ internal: false });
    await a.worker.tick();
    expect(a.tenant.iocsCreated.map((i) => [i.value, i.severity, i.platforms])).toEqual([
      ["evil.example", "low", ["windows", "linux"]],
      [SHA256, "low", ["windows", "linux"]],
    ]);
    expect((await a.timeline(a.ana)).map((e) => e.body)).toContain(
      "Response Action: Argus sent Domain evil[.]example to CrowdStrike Falcon as a custom IOC (Detect, severity Low, Windows, Linux).",
    );
  });

  test("changing an Integration's defaults leaves what is already queued as it was taken", async () => {
    const a = await acme();
    await a.take(a.ana, await a.link("domain", "evil.example"));
    await a.owner.api.integrations[":id"]["response-action-defaults"].$put({
      param: { id: a.integrationId },
      json: { severity: "critical", platforms: ["mac"], internal: false },
    });
    await a.worker.tick();
    expect(a.tenant.iocsCreated.map((i) => [i.severity, i.platforms])).toEqual([["high", ["windows", "mac", "linux"]]]);
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
    expect((await a.list(a.ana)).integrations).toEqual([
      { id: on, name: "CrowdStrike — EU", provider: "crowdstrike", defaults: { severity: "case", platforms: ["windows", "mac", "linux"], internal: false } },
    ]);

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

describe("Deleting an Integration with Response Actions", () => {
  test("it is refused while what Argus sent through it is still in place, and allowed once removed", async () => {
    const a = await acme();
    const domain = await a.link("domain", "evil.example");
    const taken = (await a.take(a.ana, domain)).body.responseAction!;
    const del = () => a.owner.api.integrations[":id"].$delete({ param: { id: a.integrationId } });

    // Pending, then Active: Argus holds it in Falcon.
    const pending = await del();
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ error: "1 Response Action taken through this Integration is still in place; remove it from its Case first" });
    await a.worker.tick();
    expect((await del()).status).toBe(409);

    expect((await a.remove(a.ana, taken.id)).status).toBe(200);
    await a.worker.tick();
    expect((await a.list(a.ana)).responseActions[0]).toMatchObject({ state: "removed" });
    expect((await del()).status).toBe(200);

    // The record stays on the Case, under the deleted Integration's name; nothing more is taken through it.
    expect((await a.list(a.ana)).responseActions[0]).toMatchObject({ integration: { id: a.integrationId, name: "CrowdStrike — Prod" } });
    expect((await a.list(a.ana)).integrations).toEqual([]);
    expect((await a.take(a.ana, await a.link("domain", "worse.example"))).status).toBe(400);
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

/** Exhausts every send attempt while Falcon refuses them. */
const failAll = async (a: Awaited<ReturnType<typeof acme>>) => {
  a.tenant.refuseIocs = "Creating a custom IOC in Falcon failed: 403 access denied";
  for (let i = 0; i < MAX_RESPONSE_ACTION_ATTEMPTS; i++) {
    await a.worker.tick();
    a.t.clock.advance(60 * 60_000);
  }
  a.tenant.refuseIocs = null;
};

describe("Already present: never sending twice, never overwriting", () => {
  test("a value already sent from another Case to the same Integration is recorded already present, and nothing is sent", async () => {
    const a = await acme();
    const first = await a.take(a.ana, await a.link("domain", "evil.example"));
    await a.worker.tick();
    const sentAt = a.t.clock.now().toISOString();
    a.t.clock.advance(60_000);

    const other = await a.open("Second wave");
    const again = await a.take(a.ana, await a.link("domain", "evil.example", other), { on: other });
    expect(again).toMatchObject({
      status: 201,
      body: {
        responseAction: {
          state: "active",
          origin: "already_present",
          presentFrom: { case: { number: a.number, title: "Phishing at Acme" }, at: sentAt },
          sentAt: null,
        },
      },
    });
    await a.worker.tick();
    expect(a.tenant.iocsCreated).toHaveLength(1);
    expect(first.body.responseAction!.id).not.toBe(again.body.responseAction!.id);

    // A different Integration is a different tool: it is sent there.
    const eu = await a.add("CrowdStrike — EU", "falcon-client-0002", true);
    const toEu = await a.take(a.ana, (await a.listOn(a.ana, other))[0]!.observable!.id, { on: other, integration: eu });
    expect(toEu.body.responseAction).toMatchObject({ state: "pending", origin: "created", presentFrom: null });
    await a.worker.tick();
    expect(a.falcon.tenant("falcon-client-0002").iocsCreated).toHaveLength(1);
  });

  test("one still waiting to be sent counts too, and so does one sent from the same Case", async () => {
    const a = await acme();
    const domain = await a.link("domain", "evil.example");
    await a.take(a.ana, domain);
    const twice = await a.take(a.owner, domain);
    expect(twice.body.responseAction).toMatchObject({ state: "active", origin: "already_present", presentFrom: { case: { number: a.number } } });
    await a.worker.tick();
    expect(a.tenant.iocsCreated).toHaveLength(1);
  });

  test("an already present record says what the tool holds: the action it was first sent with", async () => {
    const a = await acme();
    const hash = await a.link("sha256", "a".repeat(64));
    await a.take(a.ana, hash, { action: "prevent" });
    const again = await a.take(a.owner, hash, { action: "detect" });
    expect(again.body.responseAction).toMatchObject({ origin: "already_present", falcon: { action: "prevent" } });
  });

  test("at most one Pending or Active created Response Action per Integration, kind and value, even when Cases send at once", async () => {
    const a = await acme();
    const cases = [a.number, await a.open("Two"), await a.open("Three"), await a.open("Four")];
    const ids = await Promise.all(cases.map((n) => a.link("ip", "185.220.101.4", n)));
    const taken = await Promise.all(cases.map((n, i) => a.take(a.ana, ids[i]!, { on: n })));
    expect(taken.map((x) => x.status)).toEqual([201, 201, 201, 201]);
    expect(taken.filter((x) => x.body.responseAction!.state === "pending")).toHaveLength(1);
    await a.worker.tick();
    expect(a.tenant.iocsCreated).toHaveLength(1);
  });

  test("a Failed one doesn't hold the value; retried once another was sent, it is recorded already present", async () => {
    const a = await acme();
    const failed = await a.take(a.ana, await a.link("domain", "evil.example"));
    await failAll(a);

    const other = await a.open("Second wave");
    const sent = await a.take(a.ana, await a.link("domain", "evil.example", other), { on: other });
    expect(sent.body.responseAction).toMatchObject({ state: "pending", origin: "created" });
    await a.worker.tick();

    const retried = await a.retry(a.ana, failed.body.responseAction!.id);
    expect(await retried.json()).toMatchObject({
      responseAction: { state: "active", origin: "already_present", presentFrom: { case: { number: other } }, lastError: null },
    });
    await a.worker.tick();
    expect(a.tenant.iocsCreated).toHaveLength(1);
  });

  test("a value Falcon already holds is recorded already present in Falcon, and the IOC is left as it was", async () => {
    const a = await acme();
    const existing = {
      type: "sha256" as const,
      value: SHA256,
      action: "detect" as const,
      severity: "low" as const,
      platforms: ["windows"],
      appliedGlobally: true as const,
      source: "Console",
      description: "Added by hand",
    };
    const heldId = a.tenant.holdIoc(existing);
    const { body } = await a.take(a.ana, await a.link("sha256", SHA256), { action: "prevent" });
    await a.worker.tick();

    expect(a.tenant.iocsCreated).toEqual([]);
    expect(a.tenant.iocsDeleted).toEqual([]);
    expect(a.tenant.iocs.get(heldId)).toEqual({ ...existing, id: heldId });
    expect((await a.list(a.ana)).responseActions).toMatchObject([
      { id: body.responseAction!.id, state: "active", origin: "in_tool", presentFrom: null, sentAt: null, lastError: null },
    ]);

    // It doesn't hold the value for Argus: another Case sending it looks in Falcon again.
    const other = await a.open("Second wave");
    const again = await a.take(a.ana, await a.link("sha256", SHA256, other), { on: other });
    expect(again.body.responseAction).toMatchObject({ state: "pending", origin: "created" });
    await a.worker.tick();
    expect((await a.listOn(a.ana, other))[0]).toMatchObject({ state: "active", origin: "in_tool" });
    expect(a.tenant.iocsCreated).toEqual([]);
  });

  test("a failed look-up in Falcon is retried like a failed send", async () => {
    const a = await acme();
    a.tenant.holdIoc({
      type: "domain",
      value: "evil.example",
      action: "detect",
      severity: "low",
      platforms: ["windows"],
      appliedGlobally: true,
      source: "Console",
      description: "",
    });
    await a.take(a.ana, await a.link("domain", "evil.example"));
    a.tenant.failNextIocCalls = 1;
    await a.worker.tick();
    expect((await a.list(a.ana)).responseActions).toMatchObject([{ state: "pending", lastError: "Calling IOC Management in Falcon failed: 503" }]);
    a.t.clock.advance(30_000);
    await a.worker.tick();
    expect((await a.list(a.ana)).responseActions).toMatchObject([{ state: "active", origin: "in_tool", lastError: null }]);
    expect(a.tenant.iocsCreated).toEqual([]);
  });

  test("an already present record can be dismissed: it is Removed, Falcon is left alone, and it is on the Timeline and in the Audit Log", async () => {
    const a = await acme();
    a.tenant.holdIoc({
      type: "domain",
      value: "held.example",
      action: "detect",
      severity: "low",
      platforms: ["windows"],
      appliedGlobally: true,
      source: "Console",
      description: "",
    });
    const inTool = await a.take(a.ana, await a.link("domain", "held.example"));
    const created = await a.take(a.ana, await a.link("domain", "evil.example"));
    const present = await a.take(a.ana, (await a.list(a.ana)).responseActions[1]!.observable!.id);
    await a.worker.tick();
    const iocs = new Map(a.tenant.iocs);

    // Only "already present" records can be dismissed; Argus removes what it created instead.
    expect(await a.dismiss(a.ana, created.body.responseAction!.id)).toEqual({
      status: 409,
      body: { error: "Only an Active Response Action that was already present can be dismissed" },
    });
    expect((await a.dismiss(a.guest, inTool.body.responseAction!.id)).status).toBe(403);
    expect((await a.dismiss(a.ana, "no-such-action")).status).toBe(404);

    a.t.clock.advance(60_000);
    for (const id of [inTool.body.responseAction!.id, present.body.responseAction!.id]) {
      const dismissed = await a.dismiss(a.owner, id);
      expect(dismissed).toMatchObject({
        status: 200,
        body: { responseAction: { state: "removed", dismissedBy: { name: "Olive Owner" }, dismissedAt: a.t.clock.now().toISOString() } },
      });
    }
    expect((await a.dismiss(a.owner, present.body.responseAction!.id)).status).toBe(409);
    expect(a.tenant.iocs).toEqual(iocs);
    expect(a.tenant.iocsDeleted).toEqual([]);
    // The created one still holds the value.
    expect((await a.list(a.ana)).responseActions.map((r) => [r.origin, r.state])).toEqual([
      ["in_tool", "removed"],
      ["created", "active"],
      ["already_present", "removed"],
    ]);

    const bodies = (await a.timeline(a.ana)).map((e) => ({ body: e.body, by: e.recordedBy.name }));
    expect(bodies).toEqual(
      expect.arrayContaining([
        {
          body: "Response Action by Ana Analyst: Domain evil[.]example was already sent to CrowdStrike Falcon as a custom IOC by Argus, so nothing was sent again.",
          by: "Ana Analyst",
        },
        { body: "Response Action: Domain held[.]example was already in CrowdStrike Falcon as a custom IOC, so Argus left it unchanged.", by: "Ana Analyst" },
        {
          body: "Response Action dismissed by Olive Owner: this Case no longer records Domain held[.]example as already in CrowdStrike Falcon; CrowdStrike Falcon was left unchanged.",
          by: "Olive Owner",
        },
        {
          body: "Response Action dismissed by Olive Owner: this Case no longer records Domain evil[.]example as already in CrowdStrike Falcon; CrowdStrike Falcon was left unchanged.",
          by: "Olive Owner",
        },
      ]),
    );
    const entries = (await a.auditLog()).filter((e) => e.action.startsWith("response_action."));
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "response_action.already_present",
          actor: expect.objectContaining({ name: "Ana Analyst" }),
          target: "Falcon custom IOC: Domain evil[.]example",
          after: "Already present: sent by Argus before; nothing was sent",
        }),
        expect.objectContaining({
          action: "response_action.already_in_tool",
          actor: expect.objectContaining({ type: "system", name: "Argus" }),
          target: "Falcon custom IOC: Domain held[.]example",
          after: "Already present in CrowdStrike Falcon; nothing was written",
        }),
        expect.objectContaining({
          action: "response_action.dismissed",
          actor: expect.objectContaining({ name: "Olive Owner" }),
          target: "Falcon custom IOC: Domain held[.]example",
          after: "Dismissed; CrowdStrike Falcon left unchanged",
        }),
      ]),
    );
  });

  test("dismissing is refused on a Closed Case", async () => {
    const a = await acme();
    const domain = await a.link("domain", "evil.example");
    await a.take(a.ana, domain);
    const present = await a.take(a.ana, domain);
    await a.ana.api.cases[":number"].close.$post({ param: param(a.number), json: { resolution: "true_positive" } });
    expect((await a.dismiss(a.owner, present.body.responseAction!.id)).status).toBe(409);
  });

  test("a Restricted Case the viewer can't see is referred to without being named", async () => {
    const a = await acme();
    const secret = await a.open("Executive mailbox compromise");
    const me = await (await a.owner.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    await a.take(a.ana, await a.link("domain", "evil.example", secret), { on: secret });
    await a.owner.api.cases[":number"].$patch({ param: param(secret), json: { assigneeId: me.user.id, restricted: true } });
    await a.worker.tick();

    const present = await a.take(a.ana, await a.link("domain", "evil.example"));
    expect(present.body.responseAction).toMatchObject({ origin: "already_present", presentFrom: { case: null } });
    expect((await a.list(a.ana)).responseActions[0]!.presentFrom).toMatchObject({ case: null });
    expect((await a.list(a.owner)).responseActions[0]!.presentFrom).toMatchObject({ case: { number: secret, title: "Executive mailbox compromise" } });
    expect((await a.list(a.guest)).responseActions[0]!.presentFrom).toMatchObject({ case: null });

    const everything = JSON.stringify([await a.timeline(a.ana), await a.auditLog()]);
    expect(everything).not.toContain("Executive mailbox compromise");
    expect(everything).not.toContain(`C-${secret}`);
    const report = await (await a.ana.api.cases[":number"].report.$get({ param: param(a.number), query: { variant: "complete", format: "markdown" } })).text();
    expect(report).toContain("sent from another Case on");
    expect(report).not.toContain(`C-${secret}`);
  });
});

describe("Sending several Observables at once", () => {
  test("one Response Action per Observable per Integration; Observables Falcon doesn't take are skipped with the reason", async () => {
    const a = await acme();
    a.t.clock.advance(1000);
    const eu = await a.add("CrowdStrike — EU", "falcon-client-0002", true);
    expect((await a.list(a.ana)).integrations.map((i) => i.name)).toEqual(["CrowdStrike — Prod", "CrowdStrike — EU"]);
    const domain = await a.link("domain", "evil.example");
    const url = await a.link("url", "https://evil.example/login");
    const hash = await a.link("sha256", SHA256);
    const email = await a.link("email", "ceo@evil.example");

    const sent = await a.takeMany(a.ana, [domain, url, hash, email], { integrations: [a.integrationId, eu] });
    expect(sent.status).toBe(201);
    expect(sent.body.responseActions!.map((r) => [r.observable.value, r.integration!.id, r.state])).toEqual([
      ["evil.example", a.integrationId, "pending"],
      ["evil.example", eu, "pending"],
      [SHA256, a.integrationId, "pending"],
      [SHA256, eu, "pending"],
    ]);
    expect(sent.body.skipped).toEqual([
      { observable: { id: url, type: "url", value: "https://evil.example/login" }, provider: "crowdstrike", reason: "Falcon takes no custom IOC for an URL" },
      { observable: { id: email, type: "email", value: "ceo@evil.example" }, provider: "crowdstrike", reason: "Falcon takes no custom IOC for an Email" },
    ]);

    await a.worker.tick();
    expect(a.tenant.iocsCreated.map((i) => i.value)).toEqual(["evil.example", SHA256]);
    expect(a.falcon.tenant("falcon-client-0002").iocsCreated.map((i) => i.value)).toEqual(["evil.example", SHA256]);
    expect((await a.list(a.ana)).responseActions.map((r) => r.state)).toEqual(["active", "active", "active", "active"]);
    // Each is on the Timeline like one sent alone.
    expect((await a.timeline(a.ana)).filter((e) => e.body.startsWith("Response Action taken by Ana Analyst"))).toHaveLength(4);
  });

  test("Prevent goes to the hashes; domains and IPs in a Prevent send are skipped", async () => {
    const a = await acme();
    const hash = await a.link("md5", "d41d8cd98f00b204e9800998ecf8427e");
    const ip = await a.link("ip", "185.220.101.4");
    const sent = await a.takeMany(a.ana, [hash, ip], { action: "prevent" });
    expect(sent.body.responseActions!.map((r) => r.observable.value)).toEqual(["d41d8cd98f00b204e9800998ecf8427e"]);
    expect(sent.body.skipped).toEqual([
      { observable: { id: ip, type: "ip", value: "185.220.101.4" }, provider: "crowdstrike", reason: "Falcon can only Detect a domain or IP; Prevent is for hashes" },
    ]);
  });

  test("a send where everything is skipped takes nothing", async () => {
    const a = await acme();
    const url = await a.link("url", "https://evil.example/login");
    const sent = await a.takeMany(a.ana, [url]);
    expect(sent).toMatchObject({ status: 200, body: { responseActions: [], skipped: [{ observable: { id: url } }] } });
    expect((await a.list(a.ana)).responseActions).toEqual([]);
  });

  test("one already sent is recorded already present while the rest are sent", async () => {
    const a = await acme();
    const domain = await a.link("domain", "evil.example");
    const ip = await a.link("ip", "185.220.101.4");
    await a.take(a.ana, domain);
    const sent = await a.takeMany(a.ana, [domain, ip]);
    expect(sent.body.responseActions!.map((r) => [r.observable.value, r.state])).toEqual([
      ["evil.example", "active"],
      ["185.220.101.4", "pending"],
    ]);
    await a.worker.tick();
    expect(a.tenant.iocsCreated.map((i) => i.value)).toEqual(["evil.example", "185.220.101.4"]);
  });

  test("an Integration that can't take them, or an Observable not on the Case, refuses the whole send", async () => {
    const a = await acme();
    const off = await a.add("CrowdStrike — Lab", "falcon-client-0003", false);
    const domain = await a.link("domain", "evil.example");
    expect(await a.takeMany(a.ana, [domain], { integrations: [a.integrationId, off] })).toEqual({
      status: 400,
      body: { error: "That Integration doesn't take Response Actions; an Admin can turn them on in its settings" },
    });
    const other = await a.open("Other");
    const elsewhere = await a.link("ip", "185.220.101.4", other);
    expect(await a.takeMany(a.ana, [domain, elsewhere])).toEqual({ status: 404, body: { error: "Some of those Observables aren't linked to this Case" } });
    expect((await a.list(a.ana)).responseActions).toEqual([]);
  });

  test("Guests can't send several, and nobody can on a Closed Case", async () => {
    const a = await acme();
    const domain = await a.link("domain", "evil.example");
    expect((await a.takeMany(a.guest, [domain])).status).toBe(403);
    await a.ana.api.cases[":number"].close.$post({ param: param(a.number), json: { resolution: "true_positive" } });
    expect((await a.takeMany(a.owner, [domain])).status).toBe(409);
    expect((await a.list(a.owner)).responseActions).toEqual([]);
  });
});

describe("Sending an Ignored Observable", () => {
  test("is refused without confirmation, naming it, and goes ahead with it", async () => {
    const a = await acme();
    const domain = await a.link("domain", "microsoft.com");
    const ip = await a.link("ip", "185.220.101.4");
    await a.ignore(domain);

    expect(await a.takeMany(a.ana, [ip, domain])).toEqual({
      status: 409,
      body: { error: "Domain microsoft[.]com is on the Ignored list; confirm to send it anyway", ignored: [{ id: domain, type: "domain", value: "microsoft.com" }] },
    });
    expect(await a.take(a.ana, domain)).toMatchObject({ status: 409, body: { ignored: [{ id: domain }] } });
    expect((await a.list(a.ana)).responseActions).toEqual([]);

    const sent = await a.takeMany(a.ana, [ip, domain], { confirmIgnored: true });
    expect(sent.status).toBe(201);
    expect(sent.body.responseActions!.map((r) => r.observable.value)).toEqual(["185.220.101.4", "microsoft.com"]);
    await a.worker.tick();
    expect(a.tenant.iocsCreated.map((i) => i.value)).toEqual(["185.220.101.4", "microsoft.com"]);
  });

  test("one taken alone goes ahead with confirmation; one that is skipped anyway needs none", async () => {
    const a = await acme();
    const domain = await a.link("domain", "microsoft.com");
    const url = await a.link("url", "https://microsoft.com/");
    await a.ignore(domain);
    await a.ignore(url);
    expect((await a.take(a.ana, domain, {})).status).toBe(409);
    const res = await a.ana.api.cases[":number"]["response-actions"].$post({
      param: param(a.number),
      json: { observableId: domain, integrationId: a.integrationId, action: "detect", confirmIgnored: true },
    });
    expect(res.status).toBe(201);
    expect(await a.takeMany(a.ana, [url])).toMatchObject({ status: 200, body: { skipped: [{ observable: { id: url } }] } });
  });
});

describe("The Observable page lists its Response Actions", () => {
  test("with Integration, state, Case and date, from Cases the viewer can see", async () => {
    const a = await acme();
    const domain = await a.link("domain", "evil.example");
    await a.take(a.ana, domain);
    await a.worker.tick();
    const sentAt = a.t.clock.now().toISOString();
    a.t.clock.advance(60_000);
    const second = await a.open("Second wave");
    await a.link("domain", "evil.example", second);
    await a.takeMany(a.ana, [domain], { on: second });

    expect((await a.page(a.ana, domain)).responseActions).toMatchObject([
      { case: { number: second, title: "Second wave" }, state: "active", origin: "already_present", integration: { id: a.integrationId, name: "CrowdStrike — Prod" }, sentAt: null },
      {
        case: { number: a.number, title: "Phishing at Acme" },
        kind: "falcon_ioc",
        state: "active",
        origin: "created",
        integration: { id: a.integrationId, name: "CrowdStrike — Prod" },
        falcon: { action: "detect", severity: "high" },
        requestedAt: sentAt,
        sentAt,
      },
    ]);

    // Restricted to someone else, the second Case and its Response Action drop out for Ana.
    const me = await (await a.owner.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    await a.owner.api.cases[":number"].$patch({ param: param(second), json: { assigneeId: me.user.id, restricted: true } });
    expect((await a.page(a.ana, domain)).responseActions.map((r) => r.case.number)).toEqual([a.number]);
    expect((await a.page(a.owner, domain)).responseActions).toHaveLength(2);
  });

  test("Guests see those on their Case that aren't Internal, without the Integration", async () => {
    const a = await acme();
    const domain = await a.link("domain", "evil.example");
    const ip = await a.link("ip", "185.220.101.4");
    await a.take(a.ana, domain);
    await a.take(a.ana, ip, { internal: true });
    const other = await a.open("Not shared");
    await a.link("domain", "evil.example", other);
    await a.take(a.ana, domain, { on: other });

    expect((await a.page(a.guest, domain)).responseActions).toEqual([
      expect.objectContaining({ case: { number: a.number, title: "Phishing at Acme" }, integration: null, state: "pending" }),
    ]);
    expect((await a.page(a.guest, ip)).responseActions).toEqual([]);
    expect((await a.page(a.ana, ip)).responseActions).toMatchObject([{ internal: true, integration: { name: "CrowdStrike — Prod" } }]);
  });

  test("an Asset's page lists none", async () => {
    const a = await acme();
    const res = await a.ana.api.cases[":number"].assets.$post({ param: param(a.number), json: { type: "host", value: "FIN-LT-0231" } });
    const body = await res.json();
    if (!("asset" in body)) throw new Error("Could not link the Asset");
    const item = await (await a.ana.api.assets[":id"].$get({ param: { id: body.asset.id } })).json();
    expect(item).toMatchObject({ item: { responseActions: [] } });
  });
});

/** Exhausts every remove attempt while Falcon refuses them. */
const failAllRemovals = async (a: Awaited<ReturnType<typeof acme>>) => {
  a.tenant.refuseIocs = "Deleting a custom IOC in Falcon failed: 403 access denied";
  for (let i = 0; i < MAX_RESPONSE_ACTION_ATTEMPTS; i++) {
    await a.worker.tick();
    a.t.clock.advance(60 * 60_000);
  }
  a.tenant.refuseIocs = null;
};

describe("Removing Response Actions", () => {
  test("removing a created IOC deletes it in Falcon once the worker removes it, and it is Removed", async () => {
    const a = await acme();
    const { body } = await a.take(a.ana, await a.link("domain", "evil.example"));
    const id = body.responseAction!.id;
    await a.worker.tick();
    const ioc = [...a.tenant.iocs.keys()][0]!;
    a.t.clock.advance(60_000);

    const removing = await a.remove(a.ana, id);
    expect(removing).toMatchObject({
      status: 200,
      body: { responseAction: { id, state: "removing", removalRequestedBy: { name: "Ana Analyst" }, removalRequestedAt: a.t.clock.now().toISOString() } },
    });
    // Queued with the request; Falcon is untouched until the worker removes it.
    expect(a.tenant.iocsDeleted).toEqual([]);
    expect((await a.remove(a.ana, id)).body).toEqual({ error: "Only an Active Response Action can be removed" });

    await a.worker.tick();
    expect(a.tenant.iocsDeleted).toEqual([ioc]);
    expect(a.tenant.iocs.size).toBe(0);
    expect((await a.list(a.ana)).responseActions).toMatchObject([{ id, state: "removed", lastError: null }]);
    expect((await a.remove(a.ana, id)).status).toBe(409);

    // Removed, it no longer holds the value: sending it again creates it again.
    expect((await a.take(a.ana, (await a.list(a.ana)).responseActions[0]!.observable!.id)).body.responseAction).toMatchObject({ state: "pending", origin: "created" });
    await a.worker.tick();
    expect(a.tenant.iocsCreated).toHaveLength(2);
  });

  test("removing one already gone from Falcon succeeds", async () => {
    const a = await acme();
    const { body } = await a.take(a.ana, await a.link("sha256", SHA256), { action: "prevent" });
    await a.worker.tick();
    a.tenant.iocs.clear();

    await a.remove(a.ana, body.responseAction!.id);
    await a.worker.tick();
    expect((await a.list(a.ana)).responseActions).toMatchObject([{ state: "removed", lastError: null }]);
    expect((await a.timeline(a.ana)).at(-1)!.body).toBe("Response Action removed: the custom IOC for SHA-256 " + SHA256 + " was already gone from CrowdStrike Falcon.");
    expect((await a.auditLog())[0]).toMatchObject({ action: "response_action.removed", after: "Already gone from CrowdStrike Falcon; nothing to remove" });
  });

  test("a failed removal is retried with backoff, then Failed with the error, notifies whoever asked, and can be retried", async () => {
    const a = await acme();
    const { body } = await a.take(a.ana, await a.link("domain", "evil.example"));
    const id = body.responseAction!.id;
    await a.worker.tick();
    await a.remove(a.owner, id);

    a.tenant.failNextIocCalls = 1;
    await a.worker.tick();
    expect((await a.list(a.ana)).responseActions).toMatchObject([{ state: "removing", lastError: "Calling IOC Management in Falcon failed: 503" }]);
    // Not due for 30 seconds.
    a.t.clock.advance(29_000);
    await a.worker.tick();
    expect(a.tenant.iocsDeleted).toEqual([]);

    await failAllRemovals(a);
    expect((await a.list(a.ana)).responseActions).toMatchObject([
      { id, state: "failed", lastError: "Deleting a custom IOC in Falcon failed: 403 access denied", removalRequestedBy: { name: "Olive Owner" } },
    ]);
    expect(a.tenant.iocs.size).toBe(1);
    // The Member who asked for the removal hears of it, not the one who took it.
    expect(await (await a.owner.api.notifications.$get()).json()).toMatchObject({
      unread: 1,
      notifications: [
        { kind: "response_action_removal_failed", headline: `A Response Action you asked to remove from C-${a.number} could not be removed`, section: "observables" },
      ],
    });
    expect((await (await a.ana.api.notifications.$get()).json()).unread).toBe(0);

    // A Failed removal still holds the value: Falcon still has it.
    const other = await a.open("Second wave");
    expect((await a.take(a.ana, await a.link("domain", "evil.example", other), { on: other })).body.responseAction).toMatchObject({ origin: "already_present" });

    // Retried, it is Removing again, and removed once Falcon allows it.
    const retried = await a.retry(a.ana, id);
    expect(await retried.json()).toMatchObject({ responseAction: { state: "removing", lastError: null, removalRequestedBy: { name: "Ana Analyst" } } });
    await a.worker.tick();
    expect(a.tenant.iocs.size).toBe(0);
    expect((await a.list(a.ana)).responseActions).toMatchObject([{ id, state: "removed" }]);
    expect((await a.listOn(a.ana, other))[0]).toMatchObject({ state: "removed" });
  });

  test("Remove isn't available on already present records, nor on one not yet sent", async () => {
    const a = await acme();
    a.tenant.holdIoc({
      type: "domain",
      value: "held.example",
      action: "detect",
      severity: "low",
      platforms: ["windows"],
      appliedGlobally: true,
      source: "Console",
      description: "",
    });
    const inTool = await a.take(a.ana, await a.link("domain", "held.example"));
    const domain = await a.link("domain", "evil.example");
    const pending = await a.take(a.ana, domain);
    const present = await a.take(a.ana, domain);
    expect((await a.remove(a.ana, pending.body.responseAction!.id)).body).toEqual({ error: "Only an Active Response Action can be removed" });
    await a.worker.tick();

    for (const r of [inTool, present]) {
      expect(await a.remove(a.ana, r.body.responseAction!.id)).toEqual({
        status: 409,
        body: { error: "Argus didn't create this Response Action, so it can't remove it; dismiss it instead" },
      });
    }
    expect((await a.remove(a.ana, "no-such-action")).status).toBe(404);
    await a.worker.tick();
    expect(a.tenant.iocsDeleted).toEqual([]);
  });

  test("removal relied on by other Cases needs confirmation, naming those the person can see; then their records are Removed too", async () => {
    const a = await acme();
    const domain = await a.link("domain", "evil.example");
    const created = await a.take(a.ana, domain);
    // One on the same Case relies on it too, but needs no confirmation.
    const sameCase = await a.take(a.owner, domain);
    await a.worker.tick();

    const second = await a.open("Second wave");
    const secret = await a.open("Executive mailbox compromise");
    for (const n of [second, secret]) await a.take(a.ana, await a.link("domain", "evil.example", n), { on: n });
    const me = await (await a.owner.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    await a.owner.api.cases[":number"].$patch({ param: param(secret), json: { assigneeId: me.user.id, restricted: true } });

    const id = created.body.responseAction!.id;
    expect(await a.remove(a.ana, id)).toEqual({
      status: 409,
      body: { error: "2 other Cases rely on this Response Action; confirm to remove it anyway", relyingCases: [{ number: second, title: "Second wave" }], otherCases: 1 },
    });
    expect((await a.remove(a.owner, id)).body).toMatchObject({
      relyingCases: [
        { number: second, title: "Second wave" },
        { number: secret, title: "Executive mailbox compromise" },
      ],
      otherCases: 0,
    });
    expect((await a.list(a.ana)).responseActions[0]).toMatchObject({ state: "active" });

    expect((await a.remove(a.ana, id, { confirmRelying: true })).body.responseAction).toMatchObject({ state: "removing" });
    await a.worker.tick();
    expect(a.tenant.iocsDeleted).toHaveLength(1);
    expect((await a.list(a.ana)).responseActions.map((r) => [r.id, r.state])).toEqual([
      [id, "removed"],
      [sameCase.body.responseAction!.id, "removed"],
    ]);
    expect((await a.listOn(a.ana, second))[0]).toMatchObject({ state: "removed", origin: "already_present", dismissedBy: null });
    expect((await a.listOn(a.owner, secret))[0]).toMatchObject({ state: "removed" });

    // Each relying Case's Timeline says so, without naming the Case that removed it.
    const secondTimeline = await (await a.ana.api.cases[":number"].timeline.$get({ param: param(second) })).json();
    if (!("entries" in secondTimeline)) throw new Error("Could not read the Timeline");
    expect(secondTimeline.entries.at(-1)!.body).toBe(
      "Response Action removed: Argus removed the custom IOC for Domain evil[.]example from CrowdStrike Falcon at the request of the Case that sent it, so this Case no longer records it as present.",
    );
    expect(JSON.stringify(secondTimeline)).not.toContain(`C-${a.number}`);
  });

  test("a value sent from another Case while being removed is recorded already present, and Removed with it", async () => {
    const a = await acme();
    const { body } = await a.take(a.ana, await a.link("domain", "evil.example"));
    await a.worker.tick();
    await a.remove(a.ana, body.responseAction!.id);
    const other = await a.open("Second wave");
    const during = await a.take(a.ana, await a.link("domain", "evil.example", other), { on: other });
    expect(during.body.responseAction).toMatchObject({ state: "active", origin: "already_present" });
    await a.worker.tick();
    expect((await a.listOn(a.ana, other))[0]).toMatchObject({ state: "removed" });
    expect(a.tenant.iocsCreated).toHaveLength(1);
  });

  test("on a Closed Case Admins can remove without reopening; Analysts can't, and Guests never can", async () => {
    const a = await acme();
    const domain = await a.take(a.ana, await a.link("domain", "evil.example"));
    const hash = await a.take(a.ana, await a.link("sha256", SHA256), { action: "prevent" });
    await a.worker.tick();
    expect(await a.remove(a.guest, domain.body.responseAction!.id)).toMatchObject({ status: 403 });

    await a.ana.api.cases[":number"].close.$post({ param: param(a.number), json: { resolution: "true_positive" } });
    expect(await a.remove(a.ana, domain.body.responseAction!.id)).toEqual({
      status: 409,
      body: { error: "This Case is Closed and read-only; an Admin can reopen it" },
    });
    expect(await a.remove(a.guest, domain.body.responseAction!.id)).toMatchObject({ status: 403 });
    expect((await a.remove(a.owner, domain.body.responseAction!.id)).status).toBe(200);
    await a.worker.tick();
    expect((await a.list(a.owner)).responseActions.map((r) => r.state)).toEqual(["removed", "active"]);
    expect((await (await a.owner.api.cases[":number"].$get({ param: param(a.number) })).json())).toMatchObject({ case: { status: "closed" } });

    // A failed removal on a Closed Case: Admins can retry it, Analysts can't.
    await a.remove(a.owner, hash.body.responseAction!.id);
    await failAllRemovals(a);
    expect((await a.retry(a.ana, hash.body.responseAction!.id)).status).toBe(409);
    expect((await a.retry(a.guest, hash.body.responseAction!.id)).status).toBe(403);
    expect((await a.retry(a.owner, hash.body.responseAction!.id)).status).toBe(200);
    await a.worker.tick();
    expect((await a.list(a.owner)).responseActions.map((r) => r.state)).toEqual(["removed", "removed"]);
  });

  test("a removal after Response Actions were turned off fails", async () => {
    const a = await acme();
    const { body } = await a.take(a.ana, await a.link("domain", "evil.example"));
    await a.worker.tick();
    await a.remove(a.ana, body.responseAction!.id);
    await a.owner.api.integrations[":id"]["response-actions"].$put({ param: { id: a.integrationId }, json: { enabled: false } });
    await a.worker.tick();
    expect((await a.list(a.ana)).responseActions).toMatchObject([
      { state: "failed", lastError: "Response Actions were turned off for the Integration before this was removed" },
    ]);
    expect(a.tenant.iocsDeleted).toEqual([]);
  });

  test("each removal step is on the Timeline, in the Audit Log, and signalled to live sockets", async () => {
    const a = await acme();
    const { body } = await a.take(a.ana, await a.link("domain", "evil.example"));
    const id = body.responseAction!.id;
    await a.worker.tick();
    const member = await a.t.connect(a.owner);
    const guest = await a.t.connect(a.guest);

    await a.remove(a.owner, id);
    expect(await member.next((m) => m.type === "case")).toEqual({ type: "case", number: a.number });
    expect(await guest.next((m) => m.type === "case")).toEqual({ type: "case", number: a.number });
    a.tenant.refuseIocs = "Deleting a custom IOC in Falcon failed: 403 access denied";
    await failAllRemovals(a);
    await a.retry(a.ana, id);
    await a.worker.tick();
    expect(await member.next((m) => m.type === "case")).toEqual({ type: "case", number: a.number });

    const what = "Domain evil[.]example";
    expect((await a.timeline(a.ana)).slice(2).map((e) => ({ body: e.body, by: e.recordedBy.name }))).toEqual([
      { body: `Response Action removal asked for by Olive Owner: remove the custom IOC for ${what} from CrowdStrike Falcon.`, by: "Olive Owner" },
      { body: `Response Action removal failed: Argus could not remove the custom IOC for ${what} from CrowdStrike Falcon.`, by: "Olive Owner" },
      { body: `Response Action removal retried by Ana Analyst: remove the custom IOC for ${what} from CrowdStrike Falcon.`, by: "Ana Analyst" },
      { body: `Response Action removed: Argus removed the custom IOC for ${what} from CrowdStrike Falcon.`, by: "Ana Analyst" },
    ]);
    // The Guest sees the same Timeline: no Integration, no error.
    expect((await a.timeline(a.guest)).map((e) => e.body)).toEqual((await a.timeline(a.ana)).map((e) => e.body));

    const target = `Falcon custom IOC: ${what}`;
    expect((await a.auditLog()).filter((e) => e.action.startsWith("response_action.")).toReversed().slice(2)).toMatchObject([
      { action: "response_action.removal_requested", actor: { type: "member", name: "Olive Owner" }, target, after: "Remove from CrowdStrike Falcon" },
      { action: "response_action.removal_failed", actor: { type: "system", name: "Argus" }, target, after: "Deleting a custom IOC in Falcon failed: 403 access denied" },
      { action: "response_action.removal_retried", actor: { type: "member", name: "Ana Analyst" }, target },
      { action: "response_action.removed", actor: { type: "system", name: "Argus" }, target, after: "Removed from CrowdStrike Falcon" },
    ]);

    const report = await (await a.owner.api.cases[":number"].report.$get({ param: param(a.number), query: { variant: "complete", format: "markdown" } })).text();
    expect(report).toContain("Removed");
    expect(report).toContain("Removal asked for by:");
  });
});

async function dbError(query: PromiseLike<unknown>) {
  try {
    await query;
    return null;
  } catch (e) {
    return String((e as { cause?: unknown }).cause ?? e);
  }
}

describe("What a Response Action targets", () => {
  test("exactly one Observable or one Asset, enforced in the data", async () => {
    const a = await acme();
    const hash = await a.link("sha256", SHA256);
    const { body } = await a.take(a.ana, hash);
    const id = body.responseAction!.id;
    const res = await a.ana.api.cases[":number"].assets.$post({ param: param(a.number), json: { type: "host", value: "FIN-LT-0231" } });
    const linked = await res.json();
    if (!("asset" in linked)) throw new Error("Could not link the Asset");
    const asset = linked.asset.id;
    const db = a.t.deps.db;

    // An IOC given a host as well breaks both rules; Postgres names whichever it checks first.
    expect(await dbError(db.execute(sql`UPDATE response_actions SET asset_id = ${asset} WHERE id = ${id}`))).toMatch(/response_actions_(one|containment)_target/);
    expect(await dbError(db.execute(sql`UPDATE response_actions SET observable_id = NULL WHERE id = ${id}`))).toContain("response_actions_one_target");

    const copy = (observableId: string | null, assetId: string | null, as: string, kind = "falcon_containment") => sql`
      INSERT INTO response_actions (id, organization_id, case_id, observable_id, asset_id, integration_id, kind, target_type,
        target_value, state, created_by_id, created_at, state_changed_at)
      SELECT ${as}, organization_id, case_id, ${observableId}, ${assetId}, integration_id, ${kind}, target_type,
        target_value, 'removed', created_by_id, created_at, state_changed_at
      FROM response_actions WHERE id = ${id}`;
    expect(await dbError(db.execute(copy(null, null, "ra-neither", "mimecast_blocked_sender")))).toContain("response_actions_one_target");
    expect(await dbError(db.execute(copy(hash, asset, "ra-both")))).toContain("response_actions_one_target");
    expect(await dbError(db.execute(copy(null, asset, "ra-asset")))).toBeNull();
    // Containment, and only containment, is taken against an Asset.
    expect(await dbError(db.execute(copy(null, asset, "ra-blocked-host", "mimecast_blocked_sender")))).toContain("response_actions_containment_target");
    expect(await dbError(db.execute(copy(hash, null, "ra-contained-hash")))).toContain("response_actions_containment_target");
  });
});
