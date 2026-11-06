import { describe, expect, test } from "bun:test";
import { MIMECAST_CHECK_INTERVAL_MS, MIMECAST_RECHECK_MS, createMimecastHealthChecker } from "./mimecast/health";
import { createResponseActionSender } from "./response-actions/sender";
import { fakeFalcon } from "./test/fake-falcon";
import { fakeMimecast } from "./test/fake-mimecast";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const APP_ID = "mimecast-app-0003";
const APP_SECRET = "mimecast-secret-value";
const FALCON_ID = "falcon-client-0001";
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: its Owner and Ana (an Analyst), a Mimecast Integration with Response Actions on (and
 * a CrowdStrike one), a High Case opened by Ana, a Response Action sender and a health checker on a
 * fake Mimecast.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Session = ReturnType<typeof t.session>;

  const addMimecast = async (json: Record<string, unknown> = {}, as: Session = owner) => {
    const res = await as.api.integrations.$post({
      json: { provider: "mimecast", name: "Mimecast", clientId: APP_ID, clientSecret: APP_SECRET, responseActions: true, ...json } as never,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { integration?: { id: string } } };
  };
  const added = await addMimecast();
  const mimecastId = added.body.integration!.id;
  // Integrations added at the same instant have no set order; CrowdStrike comes after Mimecast.
  t.clock.advance(1);
  const falconAdded = await (
    await owner.api.integrations.$post({ json: { name: "CrowdStrike", cloud: "us-1", clientId: FALCON_ID, clientSecret: "x", responseActions: true } })
  ).json();
  if (!("integration" in falconAdded)) throw new Error("Could not add CrowdStrike");
  const falconId = falconAdded.integration.id;

  const open = async (title: string) => {
    const body = await (await ana.api.cases.$post({ json: { title, caseType: "phishing", severity: "high" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    return body.case.number;
  };
  const number = await open("Phishing at Acme");

  const mimecast = fakeMimecast();
  const account = mimecast.account(APP_ID);
  const falcon = fakeFalcon();
  const worker = createResponseActionSender(t.deps, { connect: falcon.connect, mimecast: mimecast.connect });
  const health = createMimecastHealthChecker(t.deps, { connect: mimecast.connect });

  const link = async (type: "ip" | "domain" | "url" | "email" | "sha256", value: string, on = number) => {
    const res = await ana.api.cases[":number"].observables.$post({ param: param(on), json: { type, value } });
    const body = await res.json();
    if (!("observable" in body)) throw new Error(`Could not link ${value}: ${res.status}`);
    return body.observable.id;
  };
  const take = async (
    as: Session,
    observableId: string,
    { action = "block_sender", on = number, integration = mimecastId }: { action?: "block_sender" | "block_domain" | "detect"; on?: number; integration?: string } = {},
  ) => {
    const res = await as.api.cases[":number"]["response-actions"].$post({ param: param(on), json: { observableId, integrationId: integration, action } });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown> & {
        responseAction?: { id: string; state: string; kind: string; observable: { id: string; type: string; value: string }; target: { type: string; value: string } };
      },
    };
  };
  const takeMany = async (as: Session, observableIds: string[], action: "block_sender" | "block_domain" = "block_sender") => {
    const res = await as.api.cases[":number"]["response-actions"].bulk.$post({ param: param(number), json: { observableIds, integrationIds: [mimecastId], action } });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown> & {
        responseActions?: { id: string; observable: { type: string; value: string }; target: { type: string; value: string } }[];
        skipped?: { observable: { value: string }; provider: string; reason: string }[];
      },
    };
  };
  const list = async (as: Session = ana, on = number) => {
    const body = await (await as.api.cases[":number"]["response-actions"].$get({ param: param(on) })).json();
    if (!("responseActions" in body)) throw new Error("Could not list Response Actions");
    return body;
  };
  const observables = async (on = number) => {
    const body = await (await ana.api.cases[":number"].observables.$get({ param: param(on) })).json();
    if (!("observables" in body)) throw new Error("Could not list Observables");
    return body.observables;
  };
  const remove = async (as: Session, id: string, { on = number, confirmRelying }: { on?: number; confirmRelying?: boolean } = {}) => {
    const res = await as.api.cases[":number"]["response-actions"][":id"].remove.$post({ param: { ...param(on), id }, json: { confirmRelying } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { responseAction?: { state: string } } };
  };
  const timeline = async () => {
    const body = await (await ana.api.cases[":number"].timeline.$get({ param: param(number) })).json();
    if (!("entries" in body)) throw new Error("Could not read the Timeline");
    return body.entries.map((e) => e.body);
  };
  const auditLog = async () => {
    const body = await (await owner.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };
  const integration = async (id = mimecastId) => {
    const body = await (await owner.api.integrations.$get()).json();
    if (!("integrations" in body)) throw new Error("Could not list Integrations");
    return body.integrations.find((i) => i.id === id)!;
  };
  const orgAudit = async () => {
    const body = await (await owner.api.organization["audit-log"].$get({ query: { category: "integrations" } })).json();
    if (!("entries" in body)) throw new Error("Could not read the Organization Audit Log");
    return body.entries;
  };

  return {
    t,
    owner,
    ana,
    number,
    mimecastId,
    falconId,
    addMimecast,
    open,
    account,
    mimecast,
    falcon,
    worker,
    health,
    link,
    take,
    takeMany,
    list,
    observables,
    remove,
    timeline,
    auditLog,
    integration,
    orgAudit,
  };
}

const description = (n: number, title = "Phishing at Acme") => `C-${n}: ${title}\nhttp://argus.test/cases/${n}`;

describe("Adding a Mimecast Integration", () => {
  test("an Admin adds one with API 2.0 credentials: no cloud, no Alert stream and no write-back", async () => {
    const a = await acme();
    expect(await a.integration()).toMatchObject({
      provider: "mimecast",
      name: "Mimecast",
      cloud: null,
      writeBack: false,
      responseActions: true,
      health: "connecting",
      capabilities: { receivesAlerts: false, writesBack: false, responseActions: true },
      credentials: { clientIdHint: "…0003" },
    });
    expect(JSON.stringify(await a.integration())).not.toContain(APP_SECRET);
    expect((await a.orgAudit()).find((e) => e.target === "Mimecast")).toMatchObject({
      action: "integration.created",
      after: "Mimecast · client …0003 · Response Actions on",
    });

    // Neither a cloud nor write-back can be asked for, and write-back can't be turned on.
    expect((await a.addMimecast({ name: "Mail 2", cloud: "us-1" })).status).toBe(400);
    expect((await a.addMimecast({ name: "Mail 3", writeBack: true })).status).toBe(400);
    expect((await a.addMimecast({ name: "Mail 4" }, a.ana)).status).toBe(403);
    const put = await a.owner.api.integrations[":id"]["write-back"].$put({ param: { id: a.mimecastId }, json: { enabled: true } });
    expect(put.status).toBe(422);
  });

  test("the worker checks the credentials: accepted is Connected, refused is Error with Mimecast's reason", async () => {
    const a = await acme();
    await a.health.tick();
    expect(a.account.checks).toEqual([{ clientId: APP_ID, clientSecret: APP_SECRET }]);
    expect(await a.integration()).toMatchObject({ health: "connected", healthDetail: null, healthCheckedAt: a.t.clock.now().toISOString() });

    // Not checked again until the interval has passed.
    await a.health.tick();
    expect(a.account.checks).toHaveLength(1);

    a.account.refuse = "invalid_client: Bad client credentials";
    a.t.clock.advance(MIMECAST_CHECK_INTERVAL_MS + 1);
    await a.health.tick();
    expect(await a.integration()).toMatchObject({ health: "error", healthDetail: "invalid_client: Bad client credentials" });

    // New credentials are checked at once.
    a.account.refuse = null;
    await a.owner.api.integrations[":id"].credentials.$put({ param: { id: a.mimecastId }, json: { clientId: APP_ID, clientSecret: "rotated" } });
    expect((await a.integration()).health).toBe("connecting");
    await a.health.tick();
    expect(a.account.checks.at(-1)).toEqual({ clientId: APP_ID, clientSecret: "rotated" });
    expect((await a.integration()).health).toBe("connected");
  });

  test("bad credentials from the start show as Error", async () => {
    const a = await acme();
    a.mimecast.account("mimecast-bad-0004").refuse = "invalid_client";
    const { body } = await a.addMimecast({ name: "Mail (bad)", clientId: "mimecast-bad-0004" });
    await a.health.tick();
    expect(await a.integration(body.integration!.id)).toMatchObject({ health: "error", healthDetail: "invalid_client" });
  });

  test("an unreachable Mimecast is Reconnecting and checked again soon; a paused Integration isn't checked", async () => {
    const a = await acme();
    a.account.unreachable = "connect ETIMEDOUT";
    await a.health.tick();
    expect(await a.integration()).toMatchObject({ health: "disconnected", healthDetail: "connect ETIMEDOUT" });
    a.account.unreachable = null;
    a.t.clock.advance(MIMECAST_RECHECK_MS + 1);
    await a.health.tick();
    expect((await a.integration()).health).toBe("connected");

    await a.owner.api.integrations[":id"].pause.$post({ param: { id: a.mimecastId } });
    a.t.clock.advance(MIMECAST_CHECK_INTERVAL_MS + 1);
    const checks = a.account.checks.length;
    await a.health.tick();
    expect(a.account.checks).toHaveLength(checks);
  });
});

describe("Blocking a sender in Mimecast", () => {
  test("Mimecast is offered with the Case's Integrations", async () => {
    const a = await acme();
    expect((await a.list()).integrations.map((i) => [i.name, i.provider])).toEqual([
      ["Mimecast", "mimecast"],
      ["CrowdStrike", "crowdstrike"],
    ]);
  });

  test("an email address is blocked for the whole Organization once the worker sends it", async () => {
    const a = await acme();
    const email = await a.link("email", "CEO@Invoice-Portal[.]biz");
    const taken = await a.take(a.ana, email);
    expect(taken).toMatchObject({
      status: 201,
      body: {
        responseAction: {
          kind: "mimecast_blocked_sender",
          state: "pending",
          observable: { id: email, type: "email", value: "ceo@invoice-portal.biz" },
          target: { type: "email", value: "ceo@invoice-portal.biz" },
          falcon: null,
          integration: { id: a.mimecastId, name: "Mimecast" },
        },
      },
    });
    expect(a.account.created).toEqual([]);
    await a.worker.tick();
    expect(a.account.created).toEqual([{ type: "email", value: "ceo@invoice-portal.biz", appliesTo: "everyone", description: description(a.number) }]);
    expect((await a.list()).responseActions).toMatchObject([{ state: "active", sentAt: a.t.clock.now().toISOString() }]);
    expect(await a.timeline()).toEqual(
      expect.arrayContaining([
        "Response Action taken by Ana Analyst: block Email ceo@invoice-portal[.]biz in Mimecast as a blocked sender (Block sender, everyone).",
        "Response Action: Argus blocked Email ceo@invoice-portal[.]biz in Mimecast as a blocked sender (Block sender, everyone).",
      ]),
    );
    expect((await a.auditLog()).map((e) => [e.action, e.target])).toEqual(
      expect.arrayContaining([["response_action.sent", "Mimecast blocked sender: Email ceo@invoice-portal[.]biz"]]),
    );
  });

  test("blocking the domain links the domain Observable to the Case first, by hand, and blocks it", async () => {
    const a = await acme();
    const email = await a.link("email", "ceo@invoice-portal.biz");
    const taken = await a.take(a.ana, email, { action: "block_domain" });
    expect(taken.status).toBe(201);
    const domain = (await a.observables()).find((o) => o.type === "domain");
    expect(domain).toMatchObject({ value: "invoice-portal.biz", linkedBy: { name: "Ana Analyst" }, fromAlert: null });
    expect(taken.body.responseAction).toMatchObject({
      observable: { id: domain!.id, type: "domain", value: "invoice-portal.biz" },
      target: { type: "domain", value: "invoice-portal.biz" },
    });
    expect((await a.auditLog()).map((e) => e.action)).toEqual(expect.arrayContaining(["observable.linked", "response_action.requested"]));
    await a.worker.tick();
    expect(a.account.created).toEqual([{ type: "domain", value: "invoice-portal.biz", appliesTo: "everyone", description: description(a.number) }]);

    // Already linked, it is blocked without linking it again; a second address at it is already present.
    const other = await a.link("email", "billing@invoice-portal.biz");
    expect((await a.take(a.ana, other, { action: "block_domain" })).body.responseAction).toMatchObject({ state: "active", observable: { id: domain!.id } });
    expect((await a.observables()).filter((o) => o.type === "domain")).toHaveLength(1);
  });

  test("anything but an email address is refused alone and skipped among others", async () => {
    const a = await acme();
    const domain = await a.link("domain", "evil.example");
    const ip = await a.link("ip", "185.220.101.4");
    expect(await a.take(a.ana, domain)).toEqual({ status: 400, body: { error: "Mimecast blocks email senders; it takes no Domain" } });
    expect(await a.take(a.ana, ip, { action: "block_domain" })).toEqual({ status: 400, body: { error: "Mimecast blocks email senders; it takes no IP" } });

    const one = await a.link("email", "a@evil.example");
    const two = await a.link("email", "b@evil.example");
    const sent = await a.takeMany(a.ana, [domain, one, two, ip], "block_domain");
    expect(sent.status).toBe(201);
    // Both addresses share one domain: it is blocked once.
    expect(sent.body.responseActions!.map((r) => r.target)).toEqual([{ type: "domain", value: "evil.example" }]);
    expect(sent.body.skipped!.map((s) => [s.observable.value, s.provider])).toEqual([
      ["evil.example", "mimecast"],
      ["185.220.101.4", "mimecast"],
    ]);
  });

  test("an action of another Provider is refused", async () => {
    const a = await acme();
    const email = await a.link("email", "ceo@evil.example");
    expect(await a.take(a.ana, email, { action: "detect" })).toEqual({ status: 400, body: { error: `Mimecast Integrations don't take "Detect"` } });
    expect(await a.take(a.ana, email, { integration: a.falconId })).toEqual({ status: 400, body: { error: `CrowdStrike Integrations don't take "Block sender"` } });
  });

  test("Guests can't block senders", async () => {
    const a = await acme();
    const email = await a.link("email", "ceo@evil.example");
    await a.owner.api.cases[":number"].guests.$post({ param: param(a.number), json: { email: "k.patel@lawfirm.example", name: "Kim Patel" } });
    const guest = await a.t.guestSignIn("k.patel@lawfirm.example");
    expect((await a.take(guest, email)).status).toBe(403);
  });
});

describe("Mimecast: already present and removal", () => {
  test("a sender already blocked from another Case is recorded already present, and nothing is sent", async () => {
    const a = await acme();
    await a.take(a.ana, await a.link("email", "ceo@evil.example"));
    await a.worker.tick();
    const second = await a.open("Second wave");
    const again = await a.take(a.ana, await a.link("email", "ceo@evil.example", second), { on: second });
    expect(again.body.responseAction).toMatchObject({ state: "active" });
    expect((await a.list(a.ana, second)).responseActions).toMatchObject([{ origin: "already_present", presentFrom: { case: { number: a.number } } }]);
    await a.worker.tick();
    expect(a.account.created).toHaveLength(1);
  });

  test("a sender Mimecast already blocks is recorded already present in Mimecast, and left as it was", async () => {
    const a = await acme();
    a.account.hold({ type: "email", value: "ceo@evil.example", appliesTo: "everyone", description: "Blocked by the mail team" });
    const { body } = await a.take(a.ana, await a.link("email", "ceo@evil.example"));
    await a.worker.tick();
    expect(a.account.created).toEqual([]);
    expect((await a.list()).responseActions).toMatchObject([{ state: "active", origin: "in_tool" }]);
    expect(await a.timeline()).toContain("Response Action: Email ceo@evil[.]example was already a blocked sender in Mimecast, so Argus left it unchanged.");
    // It can't be removed, only dismissed; Mimecast keeps it.
    expect((await a.remove(a.ana, body.responseAction!.id)).status).toBe(409);
    const dismissed = await a.ana.api.cases[":number"]["response-actions"][":id"].dismiss.$post({ param: { ...param(a.number), id: body.responseAction!.id } });
    expect(dismissed.status).toBe(200);
    expect(a.account.blocked.size).toBe(1);
  });

  test("removing a block Argus made deletes it in Mimecast; already gone counts as removed", async () => {
    const a = await acme();
    const first = (await a.take(a.ana, await a.link("email", "ceo@evil.example"))).body.responseAction!.id;
    const second = (await a.take(a.ana, await a.link("email", "cfo@evil.example"))).body.responseAction!.id;
    await a.worker.tick();
    const [firstEntry, secondEntry] = [...a.account.blocked.keys()];

    expect((await a.remove(a.ana, first)).body.responseAction).toMatchObject({ state: "removing" });
    a.account.blocked.delete(secondEntry!);
    await a.remove(a.ana, second);
    await a.worker.tick();
    expect(a.account.deleted).toEqual([firstEntry!]);
    expect((await a.list()).responseActions.map((r) => r.state)).toEqual(["removed", "removed"]);
    expect(await a.timeline()).toEqual(
      expect.arrayContaining([
        "Response Action removed: Argus removed the blocked sender entry for Email ceo@evil[.]example from Mimecast.",
        "Response Action removed: the blocked sender entry for Email cfo@evil[.]example was already gone from Mimecast.",
      ]),
    );
  });

  test("removal relied on by another Case needs confirmation; then its record is Removed too", async () => {
    const a = await acme();
    const id = (await a.take(a.ana, await a.link("email", "ceo@evil.example"))).body.responseAction!.id;
    await a.worker.tick();
    const second = await a.open("Second wave");
    await a.take(a.ana, await a.link("email", "ceo@evil.example", second), { on: second });

    expect(await a.remove(a.ana, id)).toEqual({
      status: 409,
      body: { error: "Another Case relies on this Response Action; confirm to remove it anyway", relyingCases: [{ number: second, title: "Second wave" }], otherCases: 0 },
    });
    await a.remove(a.ana, id, { confirmRelying: true });
    await a.worker.tick();
    expect((await a.list(a.ana, second)).responseActions.map((r) => r.state)).toEqual(["removed"]);
  });

  test("on a Closed Case an Admin removes without reopening it; an Analyst can't", async () => {
    const a = await acme();
    const id = (await a.take(a.ana, await a.link("email", "ceo@evil.example"))).body.responseAction!.id;
    await a.worker.tick();
    await a.ana.api.cases[":number"].close.$post({ param: param(a.number), json: { resolution: "true_positive" } });
    expect((await a.remove(a.ana, id)).status).toBe(409);
    expect((await a.remove(a.owner, id)).status).toBe(200);
    await a.worker.tick();
    expect(a.account.blocked.size).toBe(0);
  });

  test("a failed block is retried with backoff, then Failed with the error", async () => {
    const a = await acme();
    a.account.failNextCalls = 1;
    await a.take(a.ana, await a.link("email", "ceo@evil.example"));
    await a.worker.tick();
    expect((await a.list()).responseActions).toMatchObject([{ state: "pending", lastError: "Mimecast is unavailable (503)" }]);
    a.t.clock.advance(31_000);
    await a.worker.tick();
    expect((await a.list()).responseActions).toMatchObject([{ state: "active", lastError: null }]);
  });
});
