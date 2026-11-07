import { describe, expect, test } from "bun:test";
import { createHostEnricher } from "./crowdstrike/host-enrichment";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import epp from "./crowdstrike/fixtures/epp-detection.json";
import { createResponseActionSender, MAX_RESPONSE_ACTION_ATTEMPTS } from "./response-actions/sender";
import { fakeFalcon, fakeHost } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const PROD = "falcon-client-0001";
const AID = "8f1c2b3a4d5e6f708192a3b4c5d6e7f8";
const COUNSEL = "k.patel@lawfirm.example";
const HOST = `Host FIN-LT-0231`;
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: the Owner, Ada (an Admin) and Ben (an Analyst); a CrowdStrike Integration on US-1
 * with Host containment on (unless `containment` is false) and Response Actions off, whose endpoint
 * detection for FIN-LT-0231 is attached to a Case with outside counsel on it as a Guest; and a worker
 * fetching Enrichment and sending Response Actions, on a fake Falcon that knows the laptop.
 */
async function acme({ containment = true }: { containment?: boolean } = {}) {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ada@acme.example", role: "admin" } });
  const ada = await t.acceptInvite("ada@acme.example", PASSWORD, "Ada Admin");
  await owner.api.organization.invitations.$post({ json: { email: "ben@acme.example", role: "analyst" } });
  const ben = await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");
  type Session = ReturnType<typeof t.session>;

  const added = await (
    await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: PROD, clientSecret: "falcon-secret" } })
  ).json();
  if (!("integration" in added)) throw new Error("Could not add an Integration");
  const integrationId = added.integration.id;
  const setContainment = (as: Session, enabled: boolean, id = integrationId) =>
    as.api.integrations[":id"]["host-containment"].$put({ param: { id }, json: { enabled } });
  if (containment) await setContainment(owner, true);

  const falcon = fakeFalcon();
  const tenant = falcon.tenant(PROD);
  tenant.hosts.set(AID, fakeHost(AID, { hostGroups: ["Finance laptops", "Windows workstations"] }));
  const stream = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(stream.close);
  await stream.tick();
  const enricher = createHostEnricher(t.deps, { connect: falcon.connect });
  const sender = () => createResponseActionSender(t.deps, { connect: falcon.connect });
  const worker = sender();

  tenant.emit("EppDetectionSummaryEvent", epp);
  await tenant.drained();
  const queue = await (await owner.api.alerts.$get({ query: {} })).json();
  if (!("alerts" in queue)) throw new Error("No Alert queue");
  const alert = queue.alerts.find((x) => x.externalId === epp.CompositeId)!;

  const open = async (title: string) => {
    const opened = await (await ben.api.cases.$post({ json: { title, caseType: "malware", severity: "high" } })).json();
    if (!("case" in opened)) throw new Error("Could not open a Case");
    return opened.case.number;
  };
  const number = await open("Encoded PowerShell");
  await owner.api.alerts.attach.$post({ json: { case: number, alerts: [{ id: alert.id, version: alert.version }] } });
  await owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel", expiresAt: null } });
  const guest = await t.guestSignIn(COUNSEL);

  const assets = async (as: Session, on = number) => {
    const body = await (await as.api.cases[":number"].assets.$get({ param: param(on) })).json();
    if (!("assets" in body)) throw new Error("No Assets");
    return body.assets;
  };
  const hostId = (await assets(owner)).find((x) => x.value === "FIN-LT-0231")!.id;
  /** Links a host to Case `on` by hand; returns its id. */
  const linkHost = async (value: string, on = number) => {
    const body = await (await ben.api.cases[":number"].assets.$post({ param: param(on), json: { type: "host", value } })).json();
    if (!("asset" in body)) throw new Error(`Could not link ${value}`);
    return body.asset.id;
  };

  /** Opens the containment confirmation for host `asset` as `as` (refetching it); returns the status and body. */
  const check = async (as: Session, asset = hostId, on = number) => {
    const res = await as.api.cases[":number"].assets[":assetId"]["containment-check"].$post({ param: { ...param(on), assetId: asset } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { integrations?: CheckIntegration[] } };
  };
  /** What the confirmation shows of host `asset` now, without asking Falcon again. */
  const checked = async (as: Session, asset = hostId, on = number) => {
    const body = await (await as.api.cases[":number"].assets[":assetId"]["containment-check"].$get({ param: { ...param(on), assetId: asset } })).json();
    if (!("integrations" in body)) throw new Error("No confirmation");
    return body;
  };
  /** Contains device `deviceId` of host `asset` as `as`; returns the status and body. */
  const contain = async (
    as: Session,
    { asset = hostId, deviceId = AID, on = number, integration = integrationId, internal }: { asset?: string; deviceId?: string; on?: number; integration?: string; internal?: boolean } = {},
  ) => {
    const res = await as.api.cases[":number"]["response-actions"].containment.$post({
      param: param(on),
      json: { assetId: asset, integrationId: integration, deviceId, internal },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { responseAction?: { id: string; state: string; origin: string } } };
  };
  const list = async (as: Session, on = number) => {
    const body = await (await as.api.cases[":number"]["response-actions"].$get({ param: param(on) })).json();
    if (!("responseActions" in body)) throw new Error("Could not list Response Actions");
    return body;
  };
  const timeline = async (as: Session) => {
    const body = await (await as.api.cases[":number"].timeline.$get({ param: param(number) })).json();
    if (!("entries" in body)) throw new Error("Could not read the Timeline");
    return body.entries.filter((e) => e.body.startsWith("Response Action")).map((e) => e.body);
  };
  const auditLog = async () => {
    const body = await (await owner.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries.filter((e) => e.action.startsWith("response_action.")).toReversed();
  };
  const orgAudit = async () => {
    const body = await (await owner.api.organization["audit-log"].$get({ query: { category: "integrations" } })).json();
    if (!("entries" in body)) throw new Error("Could not read the Organization Audit Log");
    return body.entries;
  };
  /** Ticks the worker until every attempt it makes has failed. */
  const exhaust = async () => {
    for (let i = 0; i < MAX_RESPONSE_ACTION_ATTEMPTS; i++) {
      await worker.tick();
      t.clock.advance(60 * 60_000);
    }
  };

  return {
    t,
    owner,
    ada,
    ben,
    guest,
    tenant,
    enricher,
    worker,
    sender,
    number,
    integrationId,
    hostId,
    open,
    assets,
    linkHost,
    setContainment,
    check,
    checked,
    contain,
    list,
    timeline,
    auditLog,
    orgAudit,
    exhaust,
  };
}

type CheckIntegration = {
  integration: { id: string; name: string };
  ambiguous: boolean;
  devices: { deviceId: string; refreshing: boolean; fetchedAt: string | null }[];
  lookup: { refreshing: boolean; notFound: boolean } | null;
};

describe("The Host containment setting", () => {
  test("is off by default; only Admins turn it on and off, each change in the Organization Audit Log", async () => {
    const a = await acme({ containment: false });
    const integration = async () => {
      const body = await (await a.ben.api.integrations.$get()).json();
      return body.integrations.find((i) => i.id === a.integrationId)!;
    };
    expect(await integration()).toMatchObject({ hostContainment: false, responseActions: false });
    expect((await a.setContainment(a.ben, true)).status).toBe(403);
    expect((await a.setContainment(a.ada, true)).status).toBe(200);
    expect(await integration()).toMatchObject({ hostContainment: true, responseActions: false });
    // Doing what is already so changes nothing.
    expect((await a.setContainment(a.owner, true)).status).toBe(200);
    expect((await a.setContainment(a.owner, false)).status).toBe(200);
    expect((await integration()).hostContainment).toBe(false);
    expect((await a.setContainment(a.owner, true, "nope")).status).toBe(404);

    expect((await a.orgAudit()).slice(0, 2).map((e) => [e.action, e.actor.name, e.target, e.before, e.after])).toEqual([
      ["integration.host_containment_disabled", "Olive Owner", "CrowdStrike — Prod", "Host containment on", "Host containment off"],
      ["integration.host_containment_enabled", "Ada Admin", "CrowdStrike — Prod", "Host containment off", "Host containment on"],
    ]);
  });

  test("Members are offered the Integrations that contain hosts, independently of Response Actions; Guests none", async () => {
    const a = await acme();
    expect(await a.list(a.ben)).toMatchObject({ integrations: [], containment: [{ id: a.integrationId, name: "CrowdStrike — Prod", internal: false }] });
    expect((await a.list(a.guest)).containment).toEqual([]);
    await a.setContainment(a.owner, false);
    expect((await a.list(a.ben)).containment).toEqual([]);
  });

  test("an Integration with it off refuses containment, and one queued before it was turned off fails", async () => {
    const a = await acme({ containment: false });
    expect(await a.contain(a.ben)).toMatchObject({
      status: 400,
      body: { error: "That Integration doesn't contain hosts; an Admin can turn Host containment on in its settings" },
    });
    await a.setContainment(a.owner, true);
    expect((await a.contain(a.ben)).status).toBe(201);
    await a.setContainment(a.owner, false);
    await a.worker.tick();
    expect(a.tenant.containments).toEqual([]);
    expect((await a.list(a.ben)).responseActions).toMatchObject([
      { state: "failed", lastError: "Host containment was turned off for the Integration before this was sent" },
    ]);
  });
});

describe("The containment confirmation", () => {
  test("refetches the host from Falcon and shows its name, aid, platform, host groups and last seen", async () => {
    const a = await acme();
    await a.assets(a.ben);
    await a.enricher.tick();
    const reads = a.tenant.hostReads.length;
    a.t.clock.advance(60_000);
    a.tenant.hosts.set(AID, fakeHost(AID, { hostGroups: ["Domain controllers"], lastSeen: "2026-01-01T09:30:00.000Z" }));

    // Opening it asks Falcon again, however recent the snapshot.
    const { status, body } = await a.check(a.ben);
    expect(status).toBe(200);
    expect(body.integrations).toMatchObject([{ integration: { id: a.integrationId }, ambiguous: false, devices: [{ deviceId: AID, refreshing: true }] }]);
    await a.enricher.tick();
    expect(a.tenant.hostReads).toHaveLength(reads + 1);
    expect(await a.checked(a.ben)).toEqual({
      asset: { id: a.hostId, value: "FIN-LT-0231" },
      integrations: [
        {
          integration: { id: a.integrationId, name: "CrowdStrike — Prod", internal: false },
          ambiguous: false,
          devices: [
            {
              deviceId: AID,
              consoleUrl: expect.stringContaining(AID),
              refreshing: false,
              fetchedAt: a.t.clock.now().toISOString(),
              notFound: false,
              error: null,
              hostname: "FIN-LT-0231",
              platform: "Windows",
              osVersion: "Windows 11",
              hostGroups: ["Domain controllers"],
              lastSeen: "2026-01-01T09:30:00.000Z",
              containment: "normal",
            },
          ],
          lookup: null,
        },
      ],
    });
  });

  test("an ambiguous host lists each device, and only the one picked is contained", async () => {
    const a = await acme();
    const other = "0123456789abcdef0123456789abcdef";
    const third = "fedcba9876543210fedcba9876543210";
    a.tenant.hosts.set(other, fakeHost(other, { hostname: "KIOSK-01" }));
    a.tenant.hosts.set(third, fakeHost(third, { hostname: "kiosk-01", platform: "Linux" }));
    const kiosk = await a.linkHost("KIOSK-01");

    expect((await a.check(a.ben, kiosk)).body.integrations).toMatchObject([{ devices: [], lookup: { refreshing: true } }]);
    await a.enricher.tick();
    const shown = (await a.checked(a.ben, kiosk)).integrations[0]!;
    expect(shown.ambiguous).toBe(true);
    expect(shown.devices.map((d) => [d.deviceId, d.platform]).toSorted()).toEqual([
      [other, "Windows"],
      [third, "Linux"],
    ]);

    expect(await a.contain(a.ben, { asset: kiosk, deviceId: third })).toMatchObject({ status: 201, body: { responseAction: { state: "pending" } } });
    await a.worker.tick();
    expect(a.tenant.containments).toEqual([third]);
    expect((await a.list(a.ben)).responseActions).toMatchObject([
      { kind: "falcon_containment", state: "active", observable: null, asset: { id: kiosk, type: "host", value: "KIOSK-01" }, target: { type: "device", value: third } },
    ]);
  });

  test("a host with no device can't be contained, nor a device that isn't the host's", async () => {
    const a = await acme();
    const nowhere = await a.linkHost("NOWHERE-01");
    await a.check(a.ben, nowhere);
    await a.enricher.tick();
    expect((await a.checked(a.ben, nowhere)).integrations).toMatchObject([{ devices: [], lookup: { refreshing: false, notFound: true } }]);
    expect(await a.contain(a.ben, { asset: nowhere, deviceId: AID })).toEqual({
      status: 400,
      body: { error: "Falcon has no device recorded for this host, so it can't be contained" },
    });
    expect(await a.contain(a.ben, { deviceId: "0123456789abcdef0123456789abcdef" })).toEqual({ status: 400, body: { error: "That device isn't recorded on this host" } });
    expect((await a.list(a.ben)).responseActions).toEqual([]);
  });

  test("is for Members and for hosts linked to the Case", async () => {
    const a = await acme();
    expect((await a.check(a.guest)).status).toBe(403);
    const elsewhere = await a.open("Elsewhere");
    const loner = await a.linkHost("LONER-01", elsewhere);
    expect((await a.check(a.ben, loner)).status).toBe(404);
    expect(await a.contain(a.ben, { asset: loner })).toEqual({ status: 404, body: { error: "That host isn't linked to this Case" } });
  });
});

describe("Containing a host", () => {
  test("is queued, sent to Falcon by aid, and Active once sent; the Case then shows the host being contained", async () => {
    const a = await acme();
    const { status, body } = await a.contain(a.ben);
    expect(status).toBe(201);
    expect(body.responseAction).toMatchObject({ kind: "falcon_containment", state: "pending", origin: "created", falcon: null, sentAt: null });
    expect(a.tenant.containments).toEqual([]);

    await a.worker.tick();
    expect(a.tenant.containments).toEqual([AID]);
    expect((await a.list(a.ben)).responseActions).toMatchObject([{ state: "active", sentAt: a.t.clock.now().toISOString(), lastError: null }]);

    // Its Enrichment is asked for again, and comes back pending containment.
    await a.enricher.tick();
    const host = (await a.assets(a.ben)).find((x) => x.id === a.hostId)!;
    expect(host.falcon[0]!.devices[0]!.containment).toBe("containment_pending");
  });

  test("a failed send is retried with backoff; one Falcon keeps refusing fails, notifies whoever took it, and can be retried", async () => {
    const a = await acme();
    const id = (await a.contain(a.ben)).body.responseAction!.id;
    a.tenant.failNextContainments = 1;
    await a.worker.tick();
    expect((await a.list(a.ben)).responseActions).toMatchObject([{ state: "pending", lastError: "Containing a host in Falcon failed: 503" }]);
    a.t.clock.advance(29_000);
    await a.worker.tick();
    expect(a.tenant.containments).toEqual([]);
    a.t.clock.advance(1_000);
    await a.worker.tick();
    expect(a.tenant.containments).toEqual([AID]);

    const b = await acme();
    const failing = (await b.contain(b.ben)).body.responseAction!.id;
    b.tenant.refuseContainment = "Containing a host in Falcon failed: the API client lacks the Hosts: Write scope";
    await b.exhaust();
    expect((await b.list(b.ben)).responseActions).toMatchObject([
      { id: failing, state: "failed", lastError: "Containing a host in Falcon failed: the API client lacks the Hosts: Write scope" },
    ]);
    // Guests are never told why.
    expect((await b.list(b.guest)).responseActions).toMatchObject([{ state: "failed", lastError: null, integration: null }]);
    expect(await (await b.ben.api.notifications.$get()).json()).toMatchObject({
      unread: 1,
      notifications: [{ kind: "response_action_failed", headline: `A Response Action you took on C-${b.number} failed` }],
    });

    b.tenant.refuseContainment = null;
    const retried = await b.ben.api.cases[":number"]["response-actions"][":id"].retry.$post({ param: { ...param(b.number), id: failing } });
    expect(await retried.json()).toMatchObject({ responseAction: { state: "pending", lastError: null } });
    await b.worker.tick();
    expect(b.tenant.containments).toEqual([AID]);
    expect(id).not.toBe(failing);
  });

  test("a host Falcon already reports contained is recorded already present, and nothing is sent", async () => {
    const a = await acme();
    a.tenant.hosts.set(AID, fakeHost(AID, { containment: "contained" }));
    await a.contain(a.ben);
    await a.worker.tick();
    expect(a.tenant.containments).toEqual([]);
    expect((await a.list(a.ben)).responseActions).toMatchObject([{ state: "active", origin: "in_tool", sentAt: null }]);
    expect((await a.timeline(a.ben)).at(-1)).toBe(`Response Action: ${HOST} was already contained in CrowdStrike Falcon, so Argus sent nothing.`);
  });

  test("a device Argus already contained, from this Case or another, is recorded already present and sent once", async () => {
    const a = await acme();
    await a.contain(a.ben);
    const second = await a.contain(a.ben);
    expect(second.body.responseAction).toMatchObject({ state: "active", origin: "already_present" });
    const elsewhere = await a.open("Lateral movement");
    await a.linkHost("FIN-LT-0231", elsewhere);
    expect((await a.contain(a.ben, { on: elsewhere })).body.responseAction).toMatchObject({ state: "active", origin: "already_present" });
    await a.worker.tick();
    expect(a.tenant.containments).toEqual([AID]);
  });

  test("is on the Timeline and in the Audit Log; Guests see it unless it is Internal, without the Integration", async () => {
    const a = await acme();
    await a.contain(a.ben);
    await a.worker.tick();
    expect(await a.timeline(a.ben)).toEqual([
      `Response Action taken by Ben Analyst: contain ${HOST} in CrowdStrike Falcon (device ${AID}).`,
      `Response Action: Argus contained ${HOST} in CrowdStrike Falcon (device ${AID}).`,
    ]);
    expect(await a.timeline(a.guest)).toEqual(await a.timeline(a.ben));
    const target = `Falcon host containment: ${HOST}`;
    expect(await a.auditLog()).toMatchObject([
      { action: "response_action.requested", actor: { type: "member", name: "Ben Analyst" }, target, after: `device ${AID}` },
      { action: "response_action.sent", actor: { type: "system", name: "Argus" }, target },
    ]);
    expect((await a.list(a.guest)).responseActions).toMatchObject([{ kind: "falcon_containment", asset: { value: "FIN-LT-0231" }, integration: null }]);

    const kiosk = "0123456789abcdef0123456789abcdef";
    a.tenant.hosts.set(kiosk, fakeHost(kiosk, { hostname: "KIOSK-01" }));
    const host = await a.linkHost("KIOSK-01");
    await a.check(a.ben, host);
    await a.enricher.tick();
    expect((await a.contain(a.ben, { asset: host, deviceId: kiosk, internal: true })).status).toBe(201);
    expect((await a.list(a.ben)).responseActions).toHaveLength(2);
    expect((await a.list(a.guest)).responseActions).toHaveLength(1);
    expect((await a.timeline(a.guest)).some((b) => b.includes("KIOSK-01"))).toBe(false);
  });

  test("Guests can't contain, and nobody can on a Closed Case", async () => {
    const a = await acme();
    expect(await a.contain(a.guest)).toMatchObject({ status: 403 });
    await a.ben.api.cases[":number"].close.$post({ param: param(a.number), json: { resolution: "true_positive" } });
    expect(await a.contain(a.owner)).toEqual({ status: 409, body: { error: "This Case is Closed and read-only; an Admin can reopen it" } });
  });
});

type Acme = Awaited<ReturnType<typeof acme>>;

/** Contains the laptop from the Case as Ben, sent and Active, and Falcon reports it contained; returns its id. */
async function contained(a: Acme) {
  const id = (await a.contain(a.ben)).body.responseAction!.id;
  await a.worker.tick();
  a.tenant.hosts.set(AID, fakeHost(AID, { containment: "contained" }));
  return id;
}

/** Lifts containment Response Action `id` from Case `on` as `as`; returns the status and body. */
async function lift(a: Acme, as: Acme["ben"] | Acme["guest"], id: string, { on = a.number, confirmRelying }: { on?: number; confirmRelying?: boolean } = {}) {
  const res = await as.api.cases[":number"]["response-actions"][":id"].remove.$post({ param: { ...param(on), id }, json: { confirmRelying } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { responseAction?: { state: string } } };
}

describe("Lifting containment Argus imposed", () => {
  test("is Removing, then Removed once Falcon has lifted it; the Case then shows the host being released", async () => {
    const a = await acme();
    const id = await contained(a);
    expect(await lift(a, a.ben, id)).toMatchObject({ status: 200, body: { responseAction: { state: "removing", removalRequestedBy: { name: "Ben Analyst" } } } });
    expect(a.tenant.lifts).toEqual([]);
    await a.worker.tick();
    expect(a.tenant.lifts).toEqual([AID]);
    expect((await a.list(a.ben)).responseActions).toMatchObject([{ id, state: "removed", lastError: null }]);
    await a.enricher.tick();
    const host = (await a.assets(a.ben)).find((x) => x.id === a.hostId)!;
    expect(host.falcon[0]!.devices[0]!.containment).toBe("lift_containment_pending");
  });

  test("a host Falcon already reports released counts as lifted, and nothing is sent", async () => {
    const a = await acme();
    const id = await contained(a);
    a.tenant.hosts.set(AID, fakeHost(AID, { containment: "normal" }));
    await lift(a, a.ben, id);
    await a.worker.tick();
    expect(a.tenant.lifts).toEqual([]);
    expect((await a.list(a.ben)).responseActions).toMatchObject([{ id, state: "removed" }]);
    expect((await a.timeline(a.ben)).at(-1)).toBe(`Response Action removed: ${HOST} was already released in CrowdStrike Falcon.`);
    expect((await a.auditLog()).at(-1)).toMatchObject({ action: "response_action.removed", after: "Already released in CrowdStrike Falcon; nothing to lift" });
  });

  test("a lift Falcon keeps refusing fails, notifies whoever asked, and can be retried", async () => {
    const a = await acme();
    const id = await contained(a);
    a.tenant.refuseLifts = "Lifting containment in Falcon failed: the API client lacks the Hosts: Write scope";
    await lift(a, a.ada, id);
    await a.exhaust();
    expect((await a.list(a.ben)).responseActions).toMatchObject([
      { id, state: "failed", lastError: "Lifting containment in Falcon failed: the API client lacks the Hosts: Write scope", removalRequestedBy: { name: "Ada Admin" } },
    ]);
    expect(await (await a.ada.api.notifications.$get()).json()).toMatchObject({ unread: 1, notifications: [{ kind: "response_action_removal_failed" }] });
    expect((await a.timeline(a.ben)).at(-1)).toBe(`Response Action removal failed: Argus could not lift the containment of ${HOST} in CrowdStrike Falcon.`);

    a.tenant.refuseLifts = null;
    const retried = await a.ben.api.cases[":number"]["response-actions"][":id"].retry.$post({ param: { ...param(a.number), id } });
    expect(await retried.json()).toMatchObject({ responseAction: { state: "removing", lastError: null } });
    await a.worker.tick();
    expect(a.tenant.lifts).toEqual([AID]);
    expect((await a.list(a.ben)).responseActions).toMatchObject([{ id, state: "removed" }]);
  });

  test("names the other Cases relying on it that the Member can see, and lifting it ends their records too", async () => {
    const a = await acme();
    const id = await contained(a);
    const lateral = await a.open("Lateral movement");
    await a.linkHost("FIN-LT-0231", lateral);
    const relyingId = (await a.contain(a.ben, { on: lateral })).body.responseAction!.id;
    // A Restricted Case Ben can't see relies on it too.
    const insider = await a.open("Insider");
    await a.linkHost("FIN-LT-0231", insider);
    expect((await a.contain(a.owner, { on: insider })).body.responseAction).toMatchObject({ origin: "already_present" });
    expect((await a.owner.api.cases[":number"].$patch({ param: param(insider), json: { restricted: true } })).status).toBe(200);

    expect(await lift(a, a.ben, id)).toEqual({
      status: 409,
      body: { error: "2 other Cases rely on this Response Action; confirm to lift it anyway", relyingCases: [{ number: lateral, title: "Lateral movement" }], otherCases: 1 },
    });
    expect((await a.list(a.ben)).responseActions).toMatchObject([{ id, state: "active" }]);
    expect((await lift(a, a.ben, id, { confirmRelying: true })).status).toBe(200);
    await a.worker.tick();
    expect(a.tenant.lifts).toEqual([AID]);
    expect((await a.list(a.ben, lateral)).responseActions).toMatchObject([{ id: relyingId, state: "removed" }]);
    expect((await a.list(a.owner, insider)).responseActions).toMatchObject([{ state: "removed" }]);
    const body = await (await a.ben.api.cases[":number"].timeline.$get({ param: param(lateral) })).json();
    if (!("entries" in body)) throw new Error("Could not read the Timeline");
    expect(body.entries.map((e) => e.body).at(-1)).toBe(
      `Response Action removed: Argus lifted the containment of ${HOST} in CrowdStrike Falcon at the request of the Case that contained it, so this Case no longer records it as contained.`,
    );
  });

  test("is on the Timeline and in the Audit Log", async () => {
    const a = await acme();
    const id = await contained(a);
    await lift(a, a.ben, id);
    await a.worker.tick();
    expect((await a.timeline(a.ben)).slice(2)).toEqual([
      `Response Action removal asked for by Ben Analyst: lift the containment of ${HOST} in CrowdStrike Falcon.`,
      `Response Action removed: Argus lifted the containment of ${HOST} in CrowdStrike Falcon.`,
    ]);
    const target = `Falcon host containment: ${HOST}`;
    expect((await a.auditLog()).slice(2)).toMatchObject([
      { action: "response_action.removal_requested", actor: { type: "member", name: "Ben Analyst" }, target, after: "Lift containment in CrowdStrike Falcon" },
      { action: "response_action.removed", actor: { type: "system", name: "Argus" }, target, after: "Containment lifted in CrowdStrike Falcon" },
    ]);
  });

  test("is for Members, of containment Argus imposed and that is Active; on a Closed Case only Admins lift it", async () => {
    const a = await acme();
    const id = await contained(a);
    expect((await lift(a, a.guest, id)).status).toBe(403);
    a.tenant.hosts.set(AID, fakeHost(AID, { containment: "normal" }));
    const elsewhere = await a.open("Elsewhere");
    await a.linkHost("FIN-LT-0231", elsewhere);
    const present = (await a.contain(a.ben, { on: elsewhere })).body.responseAction!.id;
    expect(await lift(a, a.ben, present, { on: elsewhere })).toMatchObject({ status: 409 });

    await a.ben.api.cases[":number"].close.$post({ param: param(a.number), json: { resolution: "true_positive" } });
    expect(await lift(a, a.ben, id)).toMatchObject({ status: 409, body: { error: "This Case is Closed and read-only; an Admin can reopen it" } });
    expect(await lift(a, a.ada, id, { confirmRelying: true })).toMatchObject({ status: 200, body: { responseAction: { state: "removing" } } });
    expect(await lift(a, a.ada, id)).toMatchObject({ status: 409, body: { error: "Only an Active Response Action can be removed" } });
  });
});
