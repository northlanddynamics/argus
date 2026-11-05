import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const COUNSEL = "k.patel@lawfirm.example";
const HOUR = 60 * 60 * 1000;
const param = (number: number) => ({ number: String(number) });

/** Acme Security: the Owner, Adam (an Admin) and Ana (an Analyst), signed in, and one Case. */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  const join = async (email: string, role: "admin" | "analyst", name: string) => {
    await owner.api.organization.invitations.$post({ json: { email, role } });
    return t.acceptInvite(email, PASSWORD, name);
  };
  const admin = await join("adam@acme.example", "admin", "Adam Admin");
  const ana = await join("ana@acme.example", "analyst", "Ana Analyst");
  type Session = ReturnType<typeof t.session>;

  const opened = await (await owner.api.cases.$post({ json: { title: "Phishing wave", caseType: "phishing", severity: "high" } })).json();
  if (!("case" in opened)) throw new Error("Could not open a Case");
  const number = opened.case.number;

  const observe = async (type: "ip" | "domain", value: string) => {
    const body = await (await ana.api.cases[":number"].observables.$post({ param: param(number), json: { type, value } })).json();
    if (!("observable" in body)) throw new Error(`Could not link ${value}`);
    return body.observable.id;
  };
  const hold = async (value: string) => {
    const body = await (await ana.api.cases[":number"].assets.$post({ param: param(number), json: { type: "host", value } })).json();
    if (!("asset" in body)) throw new Error(`Could not link ${value}`);
    return body.asset.id;
  };
  const ignore = (as: Session, kind: "observables" | "assets", id: string) => as.api[kind][":id"].ignored.$put({ param: { id } });
  const unignore = (as: Session, kind: "observables" | "assets", id: string) => as.api[kind][":id"].ignored.$delete({ param: { id } });
  const page = async (as: Session, kind: "observables" | "assets", id: string) => {
    const body = await (await as.api[kind][":id"].$get({ param: { id } })).json();
    if (!("item" in body)) throw new Error("No page");
    return body.item;
  };
  const ignored = async (as: Session = ana) => {
    const res = await as.api["ignored-observables"].$get();
    const body = await res.json();
    if (!("ignored" in body)) throw new Error(`Could not list the Ignored list: ${res.status}`);
    return body.ignored;
  };
  const orgAudit = async () => {
    const body = await (await owner.api.organization["audit-log"].$get({ query: { category: "ignored-observables" } })).json();
    if (!("entries" in body)) throw new Error("Could not read the Organization Audit Log");
    return body.entries;
  };
  const inviteGuest = async () => {
    const res = await owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel", expiresAt: null } });
    if (res.status !== 201) throw new Error(`Could not invite the Guest: ${res.status}`);
    return t.guestSignIn(COUNSEL);
  };

  return { t, owner, admin, ana, number, observe, hold, ignore, unignore, page, ignored, orgAudit, inviteGuest };
}

describe("Ignored Observables", () => {
  test("Admins add Observables and Assets to the Ignored list and remove them; Analysts can't", async () => {
    const a = await acme();
    const resolver = await a.observe("ip", "8.8.8.8");
    const domain = await a.observe("domain", "acme.example");
    const host = await a.hold("DC01");

    expect((await a.ignore(a.ana, "observables", resolver)).status).toBe(403);
    expect((await a.page(a.ana, "observables", resolver)).ignored).toBeNull();

    const added = await a.ignore(a.admin, "observables", resolver);
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ changed: true });
    a.t.clock.advance(HOUR);
    expect((await a.ignore(a.owner, "assets", host)).status).toBe(200);
    a.t.clock.advance(HOUR);
    await a.ignore(a.admin, "observables", domain);

    expect((await a.page(a.ana, "observables", resolver)).ignored).toMatchObject({ by: { name: "Adam Admin" } });
    expect((await a.page(a.ana, "assets", host)).ignored).toMatchObject({ by: { name: "Olive Owner" } });
    expect((await a.ignored()).map((e) => [e.kind, e.type, e.value, e.by.name])).toEqual([
      ["observable", "domain", "acme.example", "Adam Admin"],
      ["asset", "host", "DC01", "Olive Owner"],
      ["observable", "ip", "8.8.8.8", "Adam Admin"],
    ]);

    expect((await a.unignore(a.ana, "observables", domain)).status).toBe(403);
    const removed = await a.unignore(a.admin, "observables", domain);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ changed: true });
    expect((await a.page(a.ana, "observables", domain)).ignored).toBeNull();
    expect((await a.ignored()).map((e) => e.value)).toEqual(["DC01", "8.8.8.8"]);

    // An Observable's id is not an Asset's, and unknown ids are not found.
    expect((await a.ignore(a.admin, "assets", resolver)).status).toBe(404);
    expect((await a.unignore(a.admin, "observables", "no-such-id")).status).toBe(404);
  });

  test("each add and remove is in the Organization Audit Log; repeating one changes nothing", async () => {
    const a = await acme();
    const resolver = await a.observe("ip", "8.8.8.8");
    const host = await a.hold("DC01");
    await a.ignore(a.admin, "observables", resolver);
    expect(await (await a.ignore(a.admin, "observables", resolver)).json()).toEqual({ changed: false });
    await a.ignore(a.admin, "assets", host);
    await a.unignore(a.owner, "assets", host);
    expect(await (await a.unignore(a.owner, "assets", host)).json()).toEqual({ changed: false });

    expect((await a.orgAudit()).map((e) => [e.action, e.actor.name, e.target])).toEqual([
      ["ignored_observable.removed", "Olive Owner", "Host DC01"],
      ["ignored_observable.added", "Adam Admin", "Host DC01"],
      ["ignored_observable.added", "Adam Admin", "IP 8.8.8.8"],
    ]);
  });

  test("an item has at most one active entry, and its history is kept", async () => {
    const a = await acme();
    const resolver = await a.observe("ip", "8.8.8.8");
    await a.ignore(a.admin, "observables", resolver);
    await a.unignore(a.admin, "observables", resolver);
    a.t.clock.advance(HOUR);
    await a.ignore(a.owner, "observables", resolver);
    await a.ignore(a.admin, "observables", resolver);

    const rows = await a.t.deps.db.execute<{ ignored_at: Date; ended_at: Date | null }>(
      sql`SELECT ignored_at, ended_at FROM ignored_observables WHERE observable_id = ${resolver} ORDER BY seq`,
    );
    expect(rows.map((r) => r.ended_at === null)).toEqual([false, true]);
    expect((await a.page(a.ana, "observables", resolver)).ignored).toMatchObject({ by: { name: "Olive Owner" } });
    const duplicate = async () =>
      a.t.deps.db.execute(
        sql`INSERT INTO ignored_observables (id, organization_id, observable_id, ignored_by_id, ignored_at)
            SELECT 'dup', organization_id, observable_id, ignored_by_id, ignored_at FROM ignored_observables WHERE ended_at IS NULL`,
      );
    await expect(duplicate()).rejects.toThrow();
  });

  test("ignored items are still linked, on their page and found by search", async () => {
    const a = await acme();
    const resolver = await a.observe("ip", "8.8.8.8");
    const host = await a.hold("DC01");
    await a.ignore(a.admin, "observables", resolver);
    await a.ignore(a.admin, "assets", host);

    const linked = await (await a.ana.api.cases[":number"].observables.$get({ param: param(a.number) })).json();
    if (!("observables" in linked)) throw new Error("No Observables");
    expect(linked.observables.map((o) => o.value)).toEqual(["8.8.8.8"]);
    expect((await a.page(a.ana, "observables", resolver)).cases.map((c) => c.number)).toEqual([a.number]);
    // Linking it again on another Case still works.
    const other = await (await a.ana.api.cases.$post({ json: { title: "DNS tunnelling", caseType: "malware", severity: "low" } })).json();
    if (!("case" in other)) throw new Error("Could not open a Case");
    expect((await a.ana.api.cases[":number"].observables.$post({ param: param(other.case.number), json: { type: "ip", value: "8.8.8.8" } })).status).toBe(201);

    for (const [q, id] of [
      ["8.8.8.8", resolver],
      ["DC01", host],
    ] as const) {
      const body = await (await a.ana.api.search.$get({ query: { q } })).json();
      if (!("results" in body)) throw new Error("Could not search");
      expect(body.results.hits.map((h) => (h.item as { id?: string }).id)).toContain(id);
    }
  });

  test("Guests are told nothing of the Ignored list", async () => {
    const a = await acme();
    const resolver = await a.observe("ip", "8.8.8.8");
    await a.ignore(a.admin, "observables", resolver);
    const guest = await a.inviteGuest();
    expect((await a.page(guest, "observables", resolver)).ignored).toBeNull();
    expect((await guest.api["ignored-observables"].$get()).status).toBe(403);
    expect((await a.ignore(guest, "observables", resolver)).status).toBe(403);
    expect((await a.unignore(guest, "observables", resolver)).status).toBe(403);
  });

  test("Members hear when the list changes", async () => {
    const a = await acme();
    const resolver = await a.observe("ip", "8.8.8.8");
    const live = await a.t.connect(a.ana);
    await a.ignore(a.admin, "observables", resolver);
    expect(await live.next()).toEqual({ type: "alerts" });
  });
});
