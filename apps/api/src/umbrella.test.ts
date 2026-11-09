import { describe, expect, test } from "bun:test";
import { createResponseActionSender } from "./response-actions/sender";
import { buildTestApp } from "./test/harness";
import { UMBRELLA_LISTS_FRESH_MS, UMBRELLA_RETRY_MS } from "./umbrella/domain-checks";
import { UMBRELLA_CHECK_INTERVAL_MS, createUmbrellaHealthChecker } from "./umbrella/health";

const PASSWORD = "correct-horse-battery";
const KEY = "umbrella-key-0005";
const SECRET = "umbrella-secret-value";
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: its Owner and Ana (an Analyst), a Cisco Umbrella Integration with Response Actions
 * on, whose Umbrella holds a "Phishing domains" block list and a "Partners" allow list, a High Case
 * opened by Ana, and a Response Action sender and health checker on the same fake Umbrella.
 */
async function acme({ chooseList = true }: { chooseList?: boolean } = {}) {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Session = ReturnType<typeof t.session>;

  const account = t.umbrella.account(KEY);
  const phishing = account.list("Phishing domains", "block");
  const partners = account.list("Partners", "allow");

  const addUmbrella = async (json: Record<string, unknown> = {}, as: Session = owner) => {
    const res = await as.api.integrations.$post({
      json: { provider: "umbrella", name: "Umbrella", clientId: KEY, clientSecret: SECRET, responseActions: true, ...json } as never,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { integration?: { id: string } } };
  };
  const umbrellaId = (await addUmbrella()).body.integration!.id;

  const lists = async (as: Session = owner, id = umbrellaId) => {
    const res = await as.api.integrations[":id"]["destination-lists"].$get({ param: { id } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const choose = async (destinationListId: number, as: Session = owner, id = umbrellaId) => {
    const res = await as.api.integrations[":id"]["destination-list"].$put({ param: { id }, json: { destinationListId } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  if (chooseList) await choose(phishing);

  const open = async (title: string) => {
    const body = await (await ana.api.cases.$post({ json: { title, caseType: "phishing", severity: "high" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    return body.case.number;
  };
  const number = await open("Phishing at Acme");

  const worker = createResponseActionSender(t.deps, { umbrella: t.umbrella.connect });
  const health = createUmbrellaHealthChecker(t.deps, { connect: t.umbrella.connect });

  const link = async (type: "ip" | "domain" | "url" | "email", value: string, on = number) => {
    const res = await ana.api.cases[":number"].observables.$post({ param: param(on), json: { type, value } });
    const body = await res.json();
    if (!("observable" in body)) throw new Error(`Could not link ${value}: ${res.status}`);
    return body.observable.id;
  };
  const take = async (as: Session, observableId: string, { on = number }: { on?: number } = {}) => {
    const res = await as.api.cases[":number"]["response-actions"].$post({
      param: param(on),
      json: { observableId, integrationId: umbrellaId, action: "add_to_destination_list" },
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown> & {
        responseAction?: { id: string; state: string; kind: string; target: { type: string; value: string }; destinationList: unknown };
      },
    };
  };
  const list = async (as: Session = ana, on = number) => {
    const body = await (await as.api.cases[":number"]["response-actions"].$get({ param: param(on) })).json();
    if (!("responseActions" in body)) throw new Error("Could not list Response Actions");
    return body;
  };
  const remove = async (as: Session, id: string) => {
    const res = await as.api.cases[":number"]["response-actions"][":id"].remove.$post({ param: { ...param(number), id }, json: {} });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const timeline = async () => {
    const body = await (await ana.api.cases[":number"].timeline.$get({ param: param(number) })).json();
    if (!("entries" in body)) throw new Error("Could not read the Timeline");
    return body.entries.map((e) => e.body);
  };
  const integration = async (id = umbrellaId) => {
    const body = await (await owner.api.integrations.$get()).json();
    if (!("integrations" in body)) throw new Error("Could not list Integrations");
    return body.integrations.find((i) => i.id === id)!;
  };
  const orgAudit = async () => {
    const body = await (await owner.api.organization["audit-log"].$get({ query: { category: "integrations" } })).json();
    if (!("entries" in body)) throw new Error("Could not read the Organization Audit Log");
    return body.entries;
  };
  const check = async (domain: string, { as = ana, refresh = false }: { as?: Session; refresh?: boolean } = {}) => {
    const res = refresh
      ? await as.api["umbrella-checks"].refresh.$post({ json: { domain } })
      : await as.api["umbrella-checks"].$get({ query: { domain } });
    return { status: res.status as number, body: (await res.json()) as Record<string, unknown> & { check?: { domain: string; integrations: Record<string, unknown>[] } } };
  };

  return { t, owner, ana, number, umbrellaId, account, phishing, partners, addUmbrella, lists, choose, open, worker, health, link, take, list, remove, timeline, integration, orgAudit, check };
}

describe("Adding a Cisco Umbrella Integration", () => {
  test("an Admin adds one with an API key and secret: no cloud, Alert stream or write-back", async () => {
    const a = await acme({ chooseList: false });
    expect(await a.integration()).toMatchObject({
      provider: "umbrella",
      name: "Umbrella",
      cloud: null,
      writeBack: false,
      responseActions: true,
      destinationList: null,
      health: "connecting",
      capabilities: { receivesAlerts: false, writesBack: false, responseActions: true, checksDomains: true },
      credentials: { clientIdHint: "…0005" },
    });
    expect(JSON.stringify(await a.integration())).not.toContain(SECRET);
    expect((await a.orgAudit()).find((e) => e.target === "Umbrella")).toMatchObject({
      action: "integration.created",
      after: "Cisco Umbrella · key …0005 · Response Actions on",
    });
    expect((await a.addUmbrella({ name: "Umbrella 2", cloud: "us-1" })).status).toBe(400);
    expect((await a.addUmbrella({ name: "Umbrella 3" }, a.ana)).status).toBe(403);
  });

  test("the worker checks the credentials: accepted is Connected, refused is Error with Umbrella's reason", async () => {
    const a = await acme();
    await a.health.tick();
    expect(a.account.checks).toEqual([{ clientId: KEY, clientSecret: SECRET }]);
    expect((await a.integration()).health).toBe("connected");

    a.account.refuse = "invalid_client";
    a.t.clock.advance(UMBRELLA_CHECK_INTERVAL_MS + 1);
    await a.health.tick();
    expect(await a.integration()).toMatchObject({ health: "error", healthDetail: "invalid_client" });
  });

  test("an Admin chooses the destination list it adds domains to, from Umbrella's lists", async () => {
    const a = await acme({ chooseList: false });
    expect(await a.lists()).toEqual({
      status: 200,
      body: {
        destinationLists: [
          { id: a.partners, name: "Partners", access: "allow", isGlobal: false, destinationCount: 0 },
          { id: a.phishing, name: "Phishing domains", access: "block", isGlobal: false, destinationCount: 0 },
        ],
      },
    });
    expect((await a.lists(a.ana)).status).toBe(403);

    expect(await a.choose(a.phishing)).toEqual({ status: 200, body: { destinationList: { id: a.phishing, name: "Phishing domains", access: "block" } } });
    expect((await a.integration()).destinationList).toEqual({ id: a.phishing, name: "Phishing domains", access: "block" });
    expect((await a.orgAudit()).find((e) => e.action === "integration.destination_list_changed")).toMatchObject({
      target: "Umbrella",
      before: "none",
      after: `Phishing domains (Block, ${a.phishing})`,
    });

    expect(await a.choose(999_999)).toEqual({ status: 422, body: { error: "Umbrella has no destination list with that id" } });
    expect((await a.choose(a.partners, a.ana)).status).toBe(403);

    a.account.unreachable = "connect ETIMEDOUT";
    expect(await a.choose(a.partners)).toEqual({ status: 502, body: { error: "connect ETIMEDOUT" } });
  });

  test("only an Umbrella Integration has destination lists", async () => {
    const a = await acme();
    const falcon = await (
      await a.owner.api.integrations.$post({ json: { name: "CrowdStrike", cloud: "us-1", clientId: "falcon-client-0001", clientSecret: "x" } })
    ).json();
    if (!("integration" in falcon)) throw new Error("Could not add CrowdStrike");
    expect(await a.lists(a.owner, falcon.integration.id)).toEqual({ status: 422, body: { error: "CrowdStrike Integrations don't support destination lists" } });
  });
});

describe("Adding a domain to an Umbrella destination list", () => {
  test("Umbrella isn't offered on a Case until an Admin has chosen its destination list, but is named as waiting for one", async () => {
    const a = await acme({ chooseList: false });
    expect((await a.list()).integrations).toEqual([]);
    expect((await a.list()).awaitingList).toEqual([{ id: a.umbrellaId, name: "Umbrella" }]);
    const domain = await a.link("domain", "evil.example");
    expect((await a.take(a.ana, domain)).status).toBe(400);

    await a.choose(a.phishing);
    expect((await a.list()).integrations).toEqual([
      {
        id: a.umbrellaId,
        name: "Umbrella",
        provider: "umbrella",
        defaults: { severity: "case", platforms: ["windows", "mac", "linux"], internal: false },
        destinationList: { id: a.phishing, name: "Phishing domains", access: "block" },
      },
    ]);
    expect((await a.list()).awaitingList).toEqual([]);
  });

  test("a domain goes to the chosen list once the worker sends it, with a comment naming the Case", async () => {
    const a = await acme();
    const domain = await a.link("domain", "Invoice-Portal[.]biz");
    const taken = await a.take(a.ana, domain);
    expect(taken).toMatchObject({
      status: 201,
      body: {
        responseAction: {
          kind: "umbrella_destination",
          state: "pending",
          target: { type: "domain", value: "invoice-portal.biz" },
          destinationList: { id: a.phishing, name: "Phishing domains", access: "block" },
        },
      },
    });
    await a.worker.tick();
    expect(a.account.added).toEqual([
      { listId: a.phishing, destination: "invoice-portal.biz", comment: `C-${a.number}: Phishing at Acme http://argus.test/cases/${a.number}` },
    ]);
    expect((await a.list()).responseActions).toMatchObject([{ state: "active", sentAt: a.t.clock.now().toISOString() }]);
    expect(await a.timeline()).toEqual(
      expect.arrayContaining([
        "Response Action taken by Ana Analyst: add Domain invoice-portal[.]biz to the destination list Phishing domains in Cisco Umbrella (destination list Phishing domains (Block)).",
        "Response Action: Argus added Domain invoice-portal[.]biz to the destination list Phishing domains in Cisco Umbrella (destination list Phishing domains (Block)).",
      ]),
    );
  });

  test("anything but a domain is refused alone and skipped among others", async () => {
    const a = await acme();
    const email = await a.link("email", "ceo@evil.example");
    expect(await a.take(a.ana, email)).toEqual({ status: 400, body: { error: "Argus adds only domains to Umbrella destination lists; not an Email" } });

    const domain = await a.link("domain", "evil.example");
    const res = await a.ana.api.cases[":number"]["response-actions"].bulk.$post({
      param: param(a.number),
      json: { observableIds: [email, domain], integrationIds: [a.umbrellaId], action: "add_to_destination_list" },
    });
    const body = (await res.json()) as { responseActions: { target: { value: string } }[]; skipped: { observable: { value: string } }[] };
    expect(body.responseActions.map((r) => r.target.value)).toEqual(["evil.example"]);
    expect(body.skipped.map((s) => s.observable.value)).toEqual(["ceo@evil.example"]);
  });

  test("a domain the list already holds is recorded already present in Umbrella, and left as it was", async () => {
    const a = await acme();
    a.account.hold(a.phishing, "evil.example", { comment: "Added by the network team" });
    await a.take(a.ana, await a.link("domain", "evil.example"));
    await a.worker.tick();
    expect(a.account.added).toEqual([]);
    expect((await a.list()).responseActions).toMatchObject([{ state: "active", origin: "in_tool" }]);
    expect(await a.timeline()).toContain(
      "Response Action: Domain evil[.]example was already in the destination list Phishing domains in Cisco Umbrella, so Argus left it unchanged.",
    );
  });

  test("removing it takes it out of the list it went to, even after the Integration's list changed", async () => {
    const a = await acme();
    const id = (await a.take(a.ana, await a.link("domain", "evil.example"))).body.responseAction!.id;
    await a.worker.tick();
    await a.choose(a.partners);

    expect((await a.remove(a.ana, id)).status).toBe(200);
    await a.worker.tick();
    expect(a.account.removed).toEqual([{ listId: a.phishing, id: expect.any(String) }]);
    expect(a.account.lists.get(a.phishing)!.destinations).toEqual([]);
    expect((await a.list()).responseActions.map((r) => r.state)).toEqual(["removed"]);
    expect(await a.timeline()).toContain("Response Action removed: Argus removed Domain evil[.]example from the destination list Phishing domains in Cisco Umbrella.");
  });

  test("one removed from the list outside Argus is already gone", async () => {
    const a = await acme();
    const id = (await a.take(a.ana, await a.link("domain", "evil.example"))).body.responseAction!.id;
    await a.worker.tick();
    a.account.lists.get(a.phishing)!.destinations.length = 0;
    await a.remove(a.ana, id);
    await a.worker.tick();
    expect(a.account.removed).toEqual([]);
    expect(await a.timeline()).toContain("Response Action removed: Domain evil[.]example was already gone from the destination list Phishing domains in Cisco Umbrella.");
  });

  test("an Umbrella Integration holding a domain Argus added can't be deleted", async () => {
    const a = await acme();
    await a.take(a.ana, await a.link("domain", "evil.example"));
    await a.worker.tick();
    const res = await a.owner.api.integrations[":id"].$delete({ param: { id: a.umbrellaId } });
    expect(res.status).toBe(409);
  });
});

describe("Checking a domain against Umbrella's destination lists", () => {
  test("says which lists hold the domain, or a domain above it, without asking Umbrella about the domain", async () => {
    const a = await acme();
    a.account.hold(a.phishing, "login.evil.example", { comment: "C-3: Credential phish" });
    a.account.hold(a.partners, "evil.example");
    a.account.hold(a.partners, "https://evil.example/path", { type: "url" });
    a.account.hold(a.phishing, "other.example");

    const { status, body } = await a.check("Login.Evil[.]example");
    expect(status).toBe(200);
    expect(body.check).toEqual({
      domain: "login.evil.example",
      integrations: [
        {
          integration: { id: a.umbrellaId, name: "Umbrella" },
          state: "checked",
          checkedAt: a.t.clock.now().toISOString(),
          error: null,
          listCount: 2,
          matches: [
            {
              list: { id: a.phishing, name: "Phishing domains", access: "block", isGlobal: false, destinationCount: 2 },
              destination: "login.evil.example",
              matchedBy: "exact",
              comment: "C-3: Credential phish",
              addedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              list: { id: a.partners, name: "Partners", access: "allow", isGlobal: false, destinationCount: 2 },
              destination: "evil.example",
              matchedBy: "parent",
              comment: null,
              addedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
    });
    // An email address is checked by its domain; a domain below none of them is in no list.
    expect((await a.check("ceo@evil.example")).body.check!.integrations[0]!.matches).toMatchObject([{ destination: "evil.example", matchedBy: "exact" }]);
    expect((await a.check("example.org")).body.check!.integrations[0]!.matches).toEqual([]);
    expect((await a.check("not a domain")).status).toBe(422);
  });

  test("what was read is used for a while; a refresh reads the lists again", async () => {
    const a = await acme();
    await a.check("evil.example");
    const reads = a.account.reads;
    await a.check("other.example");
    expect(a.account.reads).toBe(reads);

    a.account.hold(a.phishing, "evil.example");
    expect((await a.check("evil.example")).body.check!.integrations[0]!.matches).toEqual([]);
    expect((await a.check("evil.example", { refresh: true })).body.check!.integrations[0]!.matches).toHaveLength(1);

    a.account.lists.get(a.phishing)!.destinations.length = 0;
    a.t.clock.advance(UMBRELLA_LISTS_FRESH_MS + 1);
    expect((await a.check("evil.example")).body.check!.integrations[0]!.matches).toEqual([]);
  });

  test("a failed read says why, keeps what was read before, and sets the Integration's health", async () => {
    const a = await acme();
    a.account.hold(a.phishing, "evil.example");
    await a.check("evil.example");
    a.t.clock.advance(UMBRELLA_LISTS_FRESH_MS + 1);
    a.account.refuse = "invalid_client";
    expect((await a.check("evil.example")).body.check!.integrations[0]).toMatchObject({ state: "failed", error: "invalid_client", matches: [{ destination: "evil.example" }] });
    expect(await a.integration()).toMatchObject({ health: "error", healthDetail: "invalid_client" });

    // Not tried again for a minute, unless refreshed.
    a.account.refuse = null;
    expect((await a.check("evil.example")).body.check!.integrations[0]).toMatchObject({ state: "failed" });
    a.t.clock.advance(UMBRELLA_RETRY_MS + 1);
    expect((await a.check("evil.example")).body.check!.integrations[0]).toMatchObject({ state: "checked", error: null });
    expect((await a.integration()).health).toBe("connected");
  });

  test("a paused Integration reads nothing; an Organization without Umbrella has nothing to check; Guests can't check", async () => {
    const a = await acme();
    await a.owner.api.integrations[":id"].pause.$post({ param: { id: a.umbrellaId } });
    expect((await a.check("evil.example")).body.check!.integrations).toMatchObject([{ state: "paused", checkedAt: null, matches: [] }]);
    expect(a.account.reads).toBe(0);

    await a.owner.api.integrations[":id"].$delete({ param: { id: a.umbrellaId } });
    expect((await a.check("evil.example")).body.check).toEqual({ domain: "evil.example", integrations: [] });

    await a.owner.api.cases[":number"].guests.$post({ param: param(a.number), json: { email: "k.patel@lawfirm.example", name: "Kim Patel" } });
    const guest = await a.t.guestSignIn("k.patel@lawfirm.example");
    expect((await a.check("evil.example", { as: guest })).status).toBe(403);
  });
});
