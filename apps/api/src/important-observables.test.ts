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
  const mark = (as: Session, id: string) => as.api.observables[":id"].important.$put({ param: { id } });
  const unmark = (as: Session, id: string) => as.api.observables[":id"].important.$delete({ param: { id } });
  const byValue = (as: Session, type: "ip" | "domain", value: string, important: boolean) =>
    as.api.observables.important.$post({ json: { type, value, important } });
  const page = async (as: Session, id: string) => {
    const body = await (await as.api.observables[":id"].$get({ param: { id } })).json();
    if (!("item" in body)) throw new Error("No page");
    return body.item;
  };
  const important = async (as: Session = ana) => {
    const res = await as.api["important-observables"].$get();
    const body = await res.json();
    if (!("important" in body)) throw new Error(`Could not list Important Observables: ${res.status}`);
    return body.important;
  };
  const linked = async (as: Session = ana) => {
    const body = await (await as.api.cases[":number"].observables.$get({ param: param(number) })).json();
    if (!("observables" in body)) throw new Error("No Observables");
    return body.observables;
  };
  const orgAudit = async () => {
    const body = await (await owner.api.organization["audit-log"].$get({ query: { category: "important-observables" } })).json();
    if (!("entries" in body)) throw new Error("Could not read the Organization Audit Log");
    return body.entries;
  };
  const inviteGuest = async () => {
    const res = await owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel", expiresAt: null } });
    if (res.status !== 201) throw new Error(`Could not invite the Guest: ${res.status}`);
    return t.guestSignIn(COUNSEL);
  };

  return { t, owner, admin, ana, number, observe, mark, unmark, byValue, page, important, linked, orgAudit, inviteGuest };
}

describe("Important Observables", () => {
  test("any Member marks an Observable Important and unmarks it; its page and the Case's list show it", async () => {
    const a = await acme();
    const ip = await a.observe("ip", "185.220.101.4");
    const domain = await a.observe("domain", "invoice-portal.biz");
    expect((await a.page(a.ana, ip)).important).toBeNull();
    expect((await a.linked()).map((o) => [o.value, o.important])).toEqual([
      ["185.220.101.4", false],
      ["invoice-portal.biz", false],
    ]);

    const marked = await a.mark(a.ana, ip);
    expect(marked.status).toBe(200);
    expect(await marked.json()).toEqual({ changed: true });
    a.t.clock.advance(HOUR);
    expect((await a.mark(a.admin, domain)).status).toBe(200);

    expect((await a.page(a.owner, ip)).important).toMatchObject({ by: { name: "Ana Analyst" } });
    expect((await a.linked()).map((o) => [o.value, o.important])).toEqual([
      ["185.220.101.4", true],
      ["invoice-portal.biz", true],
    ]);
    expect((await a.important()).map((e) => [e.type, e.value, e.by.name])).toEqual([
      ["domain", "invoice-portal.biz", "Adam Admin"],
      ["ip", "185.220.101.4", "Ana Analyst"],
    ]);

    const unmarked = await a.unmark(a.admin, ip);
    expect(await unmarked.json()).toEqual({ changed: true });
    expect((await a.page(a.ana, ip)).important).toBeNull();
    expect((await a.important()).map((e) => e.value)).toEqual(["invoice-portal.biz"]);

    expect((await a.mark(a.ana, "no-such-id")).status).toBe(404);
  });

  test("each mark and unmark is in the Organization Audit Log; repeating one changes nothing", async () => {
    const a = await acme();
    const ip = await a.observe("ip", "185.220.101.4");
    await a.mark(a.ana, ip);
    expect(await (await a.mark(a.ana, ip)).json()).toEqual({ changed: false });
    await a.unmark(a.admin, ip);
    expect(await (await a.unmark(a.admin, ip)).json()).toEqual({ changed: false });

    expect((await a.orgAudit()).map((e) => [e.action, e.actor.name, e.target])).toEqual([
      ["important_observable.removed", "Adam Admin", "IP 185.220.101.4"],
      ["important_observable.added", "Ana Analyst", "IP 185.220.101.4"],
    ]);
  });

  test("an Observable has at most one active mark, and its history is kept", async () => {
    const a = await acme();
    const ip = await a.observe("ip", "185.220.101.4");
    await a.mark(a.ana, ip);
    await a.unmark(a.ana, ip);
    await a.mark(a.owner, ip);

    const rows = await a.t.deps.db.execute<{ ended_at: Date | null }>(
      sql`SELECT ended_at FROM important_observables WHERE observable_id = ${ip} ORDER BY seq`,
    );
    expect(rows.map((r) => r.ended_at === null)).toEqual([false, true]);
    const duplicate = async () =>
      a.t.deps.db.execute(
        sql`INSERT INTO important_observables (id, organization_id, observable_id, marked_by_id, marked_at)
            SELECT 'dup', organization_id, observable_id, marked_by_id, marked_at FROM important_observables WHERE ended_at IS NULL`,
      );
    await expect(duplicate()).rejects.toThrow();
  });

  test("Members mark an Observable by its value wherever it is shown, even one the Organization doesn't hold yet", async () => {
    const a = await acme();
    const ip = await a.observe("ip", "185.220.101.4");
    expect(await (await a.byValue(a.ana, "ip", " 185.220.101.4 ", true)).json()).toEqual({ changed: true });
    expect(await (await a.byValue(a.ana, "ip", "185.220.101.4", true)).json()).toEqual({ changed: false });
    expect((await a.page(a.ana, ip)).important?.by.name).toBe("Ana Analyst");

    // Defanged, and never seen on a Case or Alert: it is added, so it is Important when it turns up.
    expect(await (await a.byValue(a.ana, "domain", "evil[.]example", true)).json()).toEqual({ changed: true });
    expect((await a.important()).map((e) => `${e.type} ${e.value}`)).toEqual(["domain evil.example", "ip 185.220.101.4"]);

    expect(await (await a.byValue(a.admin, "ip", "185.220.101.4", false)).json()).toEqual({ changed: true });
    expect(await (await a.byValue(a.admin, "domain", "never-held.example", false)).json()).toEqual({ changed: false });
    expect((await a.important()).map((e) => e.value)).toEqual(["evil.example"]);
    expect((await a.byValue(a.ana, "ip", "not an ip", true)).status).toBe(400);
  });

  test("Guests are told nothing of it and can't mark", async () => {
    const a = await acme();
    const ip = await a.observe("ip", "185.220.101.4");
    await a.mark(a.ana, ip);
    const guest = await a.inviteGuest();
    expect((await a.page(guest, ip)).important).toBeNull();
    expect((await a.linked(guest)).every((o) => !o.important)).toBe(true);
    expect((await guest.api["important-observables"].$get()).status).toBe(403);
    expect((await a.mark(guest, ip)).status).toBe(403);
    expect((await a.unmark(guest, ip)).status).toBe(403);
    expect((await a.byValue(guest, "ip", "185.220.101.4", false)).status).toBe(403);
  });

  test("Members hear when it changes", async () => {
    const a = await acme();
    const ip = await a.observe("ip", "185.220.101.4");
    const live = await a.t.connect(a.ana);
    await a.mark(a.admin, ip);
    expect(await live.next()).toEqual({ type: "alerts" });
  });
});
