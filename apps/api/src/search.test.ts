import { describe, expect, test } from "bun:test";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import epp from "./crowdstrike/fixtures/epp-detection.json";
import idp from "./crowdstrike/fixtures/idp-detection.json";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const COUNSEL = "k.patel@lawfirm.example";
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: the Owner, Ana (an Analyst, assigned to the Restricted Case) and Ben (an Analyst
 * who isn't), signed in; a CrowdStrike Integration delivering the fixture detections.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  const join = async (email: string, name: string) => {
    await owner.api.organization.invitations.$post({ json: { email, role: "analyst" } });
    return t.acceptInvite(email, PASSWORD, name);
  };
  const ana = await join("ana@acme.example", "Ana Analyst");
  const ben = await join("ben@acme.example", "Ben Analyst");
  type Session = ReturnType<typeof t.session>;
  const anaId = await (async () => {
    const me = await (await ana.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  })();

  await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret" } });
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const stream = falcon.tenant(CLIENT_ID);
  const queue = async () => {
    const body = await (await owner.api.alerts.$get({ query: {} })).json();
    if (!("alerts" in body)) throw new Error("No Alert queue");
    return body.alerts;
  };
  /** Delivers a fixture detection and returns its Alert's id. */
  const detect = async (name: "epp" | "idp") => {
    const [eventType, event] = name === "epp" ? (["EppDetectionSummaryEvent", epp] as const) : (["IdpDetectionSummaryEvent", idp] as const);
    stream.emit(eventType, event);
    await stream.drained();
    return (await queue()).find((a) => a.externalId === event.CompositeId)!.id;
  };

  const open = async (title: string, restricted = false) => {
    const body = await (await owner.api.cases.$post({ json: { title, caseType: "malware", severity: "high" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    const number = body.case.number;
    if (restricted) await owner.api.cases[":number"].$patch({ param: param(number), json: { assigneeId: anaId, restricted: true } });
    return number;
  };
  const summarise = async (number: number, text: string) => {
    const summary = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }] };
    const res = await owner.api.cases[":number"].summary.$put({ param: param(number), json: { summary, version: 1 } });
    if (res.status !== 200) throw new Error(`Could not save the Summary: ${res.status}`);
  };
  const observe = async (number: number, type: "ip" | "domain" | "sha256", value: string) => {
    const res = await owner.api.cases[":number"].observables.$post({ param: param(number), json: { type, value } });
    if (res.status !== 201 && res.status !== 200) throw new Error(`Could not link ${value}: ${res.status}`);
  };
  const attach = async (number: number, id: string) => {
    const version = (await queue()).find((a) => a.id === id)!.version;
    const res = await owner.api.alerts.attach.$post({ json: { case: number, alerts: [{ id, version }] } });
    if (res.status !== 200) throw new Error(`Could not attach: ${res.status}`);
  };
  type SearchQuery = { kinds?: string; page?: string; pageSize?: string };
  /** One page of results as the API gives it: one list, best first. */
  const searchPage = async (as: Session, q: string, options: SearchQuery = {}) => {
    const res = await as.api.search.$get({ query: { q, ...options } });
    const body = await res.json();
    if (!("results" in body)) throw new Error(`Could not search: ${res.status}`);
    return body.results;
  };
  type Hits = Awaited<ReturnType<typeof searchPage>>["hits"];
  const itemsOf = <K extends Hits[number]["kind"]>(hits: Hits, kind: K) =>
    hits.flatMap((h) => (h.kind === kind ? [h.item as Extract<Hits[number], { kind: K }>["item"]] : []));
  /** The first page's results sorted out by kind, each kind in rank order. */
  const search = async (as: Session, q: string, options: SearchQuery = {}) => {
    const { hits } = await searchPage(as, q, { pageSize: "50", ...options });
    return {
      cases: itemsOf(hits, "cases"),
      alerts: itemsOf(hits, "alerts"),
      observables: itemsOf(hits, "observables"),
      assets: itemsOf(hits, "assets"),
    };
  };
  const caseNumbers = async (as: Session, q: string) => (await search(as, q)).cases.map((c) => c.number);

  return { t, owner, ana, ben, open, summarise, observe, detect, attach, search, searchPage, caseNumbers };
}

describe("Global search", () => {
  test("finds Cases by title, Case Summary and reference, best match first", async () => {
    const a = await acme();
    const ransom = await a.open("Ransomware on the finance file server");
    const phish = await a.open("Invoice phishing");
    await a.summarise(phish, "The lure pointed at a fake ransomware decryptor portal.");
    await a.open("Unrelated laptop loss");

    expect(await a.caseNumbers(a.ben, "ransomware")).toEqual([ransom, phish]);
    expect(await a.caseNumbers(a.ben, "decryptor")).toEqual([phish]);
    expect(await a.caseNumbers(a.ben, '"finance file server"')).toEqual([ransom]);
    expect(await a.caseNumbers(a.ben, "ransomware -decryptor")).toEqual([ransom]);
    expect(await a.caseNumbers(a.ben, `C-${phish}`)).toEqual([phish]);
    expect(await a.caseNumbers(a.ben, "nothing-like-this")).toEqual([]);
    expect(await a.searchPage(a.ben, "  -- ")).toEqual({
      hits: [],
      total: 0,
      counts: { cases: 0, alerts: 0, observables: 0, assets: 0 },
      page: 1,
      pageSize: 20,
    });
  });

  test("Restricted Cases, and what is linked only to them, never leak", async () => {
    const a = await acme();
    const secret = await a.open("Insider exfiltration by finance director", true);
    await a.summarise(secret, "Payroll export copied to a personal drive");
    await a.observe(secret, "domain", "exfil-drop.example");
    const open = await a.open("Finance mailbox rule");

    expect(await a.caseNumbers(a.ben, "finance")).toEqual([open]);
    expect(await a.caseNumbers(a.ben, "payroll")).toEqual([]);
    expect(await a.caseNumbers(a.ben, `C-${secret}`)).toEqual([]);
    expect((await a.search(a.ben, "exfil-drop.example")).observables).toEqual([]);

    // Those it is visible to find it.
    expect(await a.caseNumbers(a.ana, "payroll")).toEqual([secret]);
    expect((await a.caseNumbers(a.owner, "finance")).toSorted()).toEqual([secret, open].toSorted());
    const found = await a.search(a.ana, "exfil-drop.example");
    expect(found.observables.map((o) => [o.value, o.cases.map((c) => c.number)])).toEqual([["exfil-drop.example", [secret]]]);
  });

  test("finds Alerts and the Observables and Assets they name, except on Cases the searcher can't see", async () => {
    const a = await acme();
    const id = await a.detect("epp");

    const byHost = await a.search(a.ben, "FIN-LT-0231");
    expect(byHost.alerts.map((x) => [x.id, x.case])).toEqual([[id, null]]);
    expect(byHost.assets.map((x) => [x.type, x.value, x.cases])).toEqual([["host", "FIN-LT-0231", []]]);
    expect((await a.search(a.ben, "EncodedPowerShellFromOffice")).alerts.map((x) => x.id)).toEqual([id]);
    expect((await a.search(a.ben, "185.220.101.4")).observables.map((o) => o.value)).toEqual(["185.220.101.4"]);
    expect((await a.search(a.ben, "invoice-portal.biz")).observables.map((o) => o.type)).toEqual(["domain"]);

    const secret = await a.open("Restricted malware Case", true);
    await a.attach(secret, id);
    const hidden = await a.search(a.ben, "FIN-LT-0231");
    expect([hidden.alerts, hidden.assets]).toEqual([[], []]);
    expect((await a.search(a.ben, "EncodedPowerShellFromOffice")).alerts).toEqual([]);
    expect((await a.search(a.ben, "185.220.101.4")).observables).toEqual([]);

    const asAna = await a.search(a.ana, "FIN-LT-0231");
    expect(asAna.alerts.map((x) => x.case?.number)).toEqual([secret]);
    expect(asAna.assets.map((x) => x.cases.map((c) => c.number))).toEqual([[secret]]);
  });

  test("Guests find only what is on their Cases and shown to them", async () => {
    const a = await acme();
    const theirs = await a.open("Phishing of the CFO");
    const other = await a.open("Phishing of the CEO");
    await a.observe(theirs, "ip", "203.0.113.7");
    await a.observe(other, "ip", "203.0.113.7");
    await a.observe(other, "domain", "ceo-lure.example");
    const res = await a.owner.api.cases[":number"].guests.$post({ param: param(theirs), json: { email: COUNSEL, name: "Kim Patel", expiresAt: null } });
    expect(res.status).toBe(201);
    const guest = await a.t.guestSignIn(COUNSEL);

    expect(await a.caseNumbers(guest, "phishing")).toEqual([theirs]);
    expect(await a.caseNumbers(guest, `C-${other}`)).toEqual([]);
    const ip = await a.search(guest, "203.0.113.7");
    expect(ip.observables.map((o) => [o.value, o.cases.map((c) => c.number)])).toEqual([["203.0.113.7", [theirs]]]);
    expect((await a.search(guest, "ceo-lure.example")).observables).toEqual([]);

    // Alerts: none from the queue, and those on their Case only once shown to them.
    const onOther = await a.detect("idp");
    await a.attach(other, onOther);
    const onTheirs = await a.detect("epp");
    await a.attach(theirs, onTheirs);
    expect((await a.search(guest, "EncodedPowerShellFromOffice")).alerts).toEqual([]);
    expect((await a.search(guest, "d.howe")).alerts).toEqual([]);
    // What only an Alert names isn't theirs to find, but what it linked to their Case is.
    expect((await a.search(guest, "FIN-LT-0231")).assets.map((x) => x.value)).toEqual(["FIN-LT-0231"]);

    const shown = await a.owner.api.cases[":number"].internal.$put({
      param: param(theirs),
      json: { item: { kind: "alert", id: onTheirs }, internal: false },
    });
    expect(shown.status).toBe(200);
    expect((await a.search(guest, "EncodedPowerShellFromOffice")).alerts.map((x) => [x.id, x.case?.number])).toEqual([[onTheirs, theirs]]);
    expect((await a.search(guest, "unusual login")).alerts).toEqual([]);
  });

  test("words match as they are typed, whole words ranking first", async () => {
    const a = await acme();
    const portal = await a.open("Beaconing to an invoice portal");
    await a.observe(portal, "domain", "invoice-portal.biz");
    const invoices = await a.open("Invoices sent from a lookalike domain");

    expect(await a.caseNumbers(a.ben, "invo")).toEqual(expect.arrayContaining([portal, invoices]));
    expect(await a.caseNumbers(a.ben, "invoice")).toEqual([portal, invoices]);
    expect((await a.search(a.ben, "invoice")).observables.map((o) => o.value)).toEqual(["invoice-portal.biz"]);
    expect(await a.caseNumbers(a.ben, "lookalike dom")).toEqual([invoices]);
  });

  test("one list of every kind, best first, a page at a time, with how many of each kind match", async () => {
    const a = await acme();
    const numbers = [];
    for (let i = 1; i <= 6; i++) numbers.push(await a.open(`Phishing wave ${i}`));
    await a.observe(numbers[0]!, "domain", "phishing-kit.example");
    const id = await a.detect("epp");

    const first = await a.searchPage(a.ben, "phishing", { pageSize: "3" });
    expect(first).toMatchObject({ total: 7, counts: { cases: 6, alerts: 0, observables: 1, assets: 0 }, page: 1, pageSize: 3 });
    expect(first.hits).toHaveLength(3);
    const all = [
      ...first.hits,
      ...(await a.searchPage(a.ben, "phishing", { pageSize: "3", page: "2" })).hits,
      ...(await a.searchPage(a.ben, "phishing", { pageSize: "3", page: "3" })).hits,
    ];
    // Every result exactly once across the pages, best first.
    expect(all).toHaveLength(7);
    const key = (h: (typeof all)[number]) => (h.kind === "cases" ? `case ${h.item.number}` : `${h.kind} ${h.item.id}`);
    expect(new Set(all.map(key)).size).toBe(7);
    expect(all.map((h) => h.rank)).toEqual(all.map((h) => h.rank).toSorted((x, y) => y - x));
    expect(all.filter((h) => h.kind === "observables").map((h) => h.kind === "observables" && h.item.value)).toEqual(["phishing-kit.example"]);
    expect((await a.searchPage(a.ben, "phishing", { pageSize: "3", page: "4" })).hits).toEqual([]);

    // Narrowed to some kinds, the total and pages are theirs; the counts still cover every kind.
    const onlyItems = await a.searchPage(a.ben, "phishing", { kinds: "observables,assets" });
    expect(onlyItems.total).toBe(1);
    expect(onlyItems.counts.cases).toBe(6);
    expect(onlyItems.hits.map((h) => h.kind)).toEqual(["observables"]);

    const onlyAlerts = await a.search(a.ben, "FIN-LT-0231", { kinds: "alerts" });
    expect(onlyAlerts.alerts.map((x) => x.id)).toEqual([id]);
    expect([onlyAlerts.cases, onlyAlerts.observables, onlyAlerts.assets]).toEqual([[], [], []]);

    // A reference outranks every text match.
    const byRef = await a.searchPage(a.ben, String(numbers[3]));
    expect(byRef.hits[0]).toMatchObject({ kind: "cases", item: { number: numbers[3] } });
    expect(byRef.hits[0]!.rank).toBeGreaterThan(100);

    expect((await a.ben.api.search.$get({ query: { q: "x", kinds: "cases,tasks" } })).status as number).toBe(400);
    expect((await a.ben.api.search.$get({ query: { q: "x", pageSize: "51" } })).status as number).toBe(400);
    expect((await a.ben.api.search.$get({ query: { q: "x", page: "0" } })).status as number).toBe(400);
  });

  test("signed-out people can't search", async () => {
    const a = await acme();
    expect((await a.t.session().api.search.$get({ query: { q: "x" } })).status as number).toBe(401);
  });
});
