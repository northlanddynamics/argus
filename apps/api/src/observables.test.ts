import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const param = (number: number) => ({ number: String(number) });

/** The Postgres error a query fails with (Drizzle wraps it as `cause`), or null if it succeeds. */
async function dbError(query: PromiseLike<unknown>) {
  try {
    await query;
    return null;
  } catch (e) {
    return String((e as { cause?: unknown }).cause ?? e);
  }
}

/** Acme Security: its Owner, Ana and Ben (Analysts), signed in. */
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
  type Member = typeof owner;

  const userId = async (as: Member) => {
    const me = await (await as.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  };

  const open = async (as: Member = owner, title = "Suspicious PowerShell") => {
    const res = await as.api.cases.$post({ json: { title, caseType: "malware", severity: "critical" } });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case.number;
  };

  type ObservableType = Parameters<Member["api"]["cases"][":number"]["observables"]["$post"]>[0]["json"]["type"];
  type AssetType = Parameters<Member["api"]["cases"][":number"]["assets"]["$post"]>[0]["json"]["type"];

  const addObservable = async (as: Member, number: number, type: ObservableType, value: string) => {
    const res = await as.api.cases[":number"].observables.$post({ param: param(number), json: { type, value } });
    return { status: res.status, body: await res.json() };
  };
  /** Links an Observable that must be valid, and returns it. */
  const observable = async (as: Member, number: number, type: ObservableType, value: string) => {
    const { status, body } = await addObservable(as, number, type, value);
    if (!("observable" in body)) throw new Error(`Could not add an Observable: ${status} ${JSON.stringify(body)}`);
    return body.observable;
  };
  const observables = async (as: Member, number: number) => {
    const res = await as.api.cases[":number"].observables.$get({ param: param(number) });
    return { status: res.status, body: await res.json() };
  };
  const unlinkObservable = async (as: Member, number: number, id: string) => {
    const res = await as.api.cases[":number"].observables[":id"].$delete({ param: { ...param(number), id } });
    return { status: res.status, body: await res.json() };
  };

  const addAsset = async (as: Member, number: number, type: AssetType, value: string) => {
    const res = await as.api.cases[":number"].assets.$post({ param: param(number), json: { type, value } });
    return { status: res.status, body: await res.json() };
  };
  const asset = async (as: Member, number: number, type: AssetType, value: string) => {
    const { status, body } = await addAsset(as, number, type, value);
    if (!("asset" in body)) throw new Error(`Could not add an Asset: ${status} ${JSON.stringify(body)}`);
    return body.asset;
  };
  const assets = async (as: Member, number: number) => {
    const res = await as.api.cases[":number"].assets.$get({ param: param(number) });
    return { status: res.status, body: await res.json() };
  };
  const unlinkAsset = async (as: Member, number: number, id: string) => {
    const res = await as.api.cases[":number"].assets[":id"].$delete({ param: { ...param(number), id } });
    return { status: res.status, body: await res.json() };
  };

  const auditLog = async (as: Member, number: number) => {
    const body = await (await as.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };

  /** A Case Restricted to Ana, its Assignee. */
  const restrictedToAna = async (title = "Exec mailbox") => {
    const number = await open(owner, title);
    await owner.api.cases[":number"].$patch({ param: param(number), json: { assigneeId: await userId(ana), restricted: true } });
    return number;
  };

  return {
    t,
    owner,
    ana,
    ben,
    userId,
    open,
    addObservable,
    observable,
    observables,
    unlinkObservable,
    addAsset,
    asset,
    assets,
    unlinkAsset,
    auditLog,
    restrictedToAna,
  };
}

describe("Adding Observables", () => {
  test("a Member adds an Observable to a Case; it lists with who added it and when", async () => {
    const { t, ana, ben, userId, open, addObservable, observables } = await acme();
    const number = await open();
    const { status, body } = await addObservable(ana, number, "ip", "185.220.101.4");
    expect(status).toBe(201);
    expect(body).toEqual({
      observable: {
        id: expect.any(String),
        type: "ip",
        value: "185.220.101.4",
        linkedBy: { id: await userId(ana), name: "Ana Analyst" },
        linkedAt: t.clock.now().toISOString(),
        seenIn: [],
      },
    });
    if (!("observable" in body)) throw new Error("Not added");
    const listed = await observables(ben, number);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ observables: [body.observable] });
  });

  test("values are normalised, and defanged ones accepted", async () => {
    const { owner, open, observable } = await acme();
    const number = await open();
    const cases: [Parameters<typeof observable>[2], string, string][] = [
      ["ip", " 010.001.000.004 ", "10.1.0.4"],
      ["ip", "2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
      ["ip", "185[.]220[.]101[.]5", "185.220.101.5"],
      ["domain", "Invoice-Portal[.]BIZ.", "invoice-portal.biz"],
      ["domain", "bücher.example", "xn--bcher-kva.example"],
      ["url", "hxxps://Invoice-Portal[.]biz/Pay?id=1", "https://invoice-portal.biz/Pay?id=1"],
      ["email", "Billing[@]Invoice-Portal[.]biz", "billing@invoice-portal.biz"],
      ["md5", "D41D8CD98F00B204E9800998ECF8427E", "d41d8cd98f00b204e9800998ecf8427e"],
      ["sha1", "da39a3ee5e6b4b0d3255bfef95601890afd80709", "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
      ["sha256", "7F3A".padEnd(64, "0"), "7f3a".padEnd(64, "0")],
    ];
    for (const [type, raw, value] of cases) {
      expect(await observable(owner, number, type, raw)).toMatchObject({ type, value });
    }
  });

  test("a value that isn't valid for its type is refused, saying what was expected", async () => {
    const { owner, open, addObservable, observables, auditLog } = await acme();
    const number = await open();
    const invalid: [Parameters<typeof addObservable>[2], string][] = [
      ["ip", "256.1.1.1"],
      ["ip", "evil.example"],
      ["domain", "10.0.0.1"],
      ["domain", "localhost"],
      ["domain", "evil example.com"],
      ["url", "javascript:alert(1)"],
      ["url", "evil.example/path"],
      ["email", "not-an-email"],
      ["md5", "abc"],
      ["sha256", "z".repeat(64)],
    ];
    for (const [type, value] of invalid) {
      const { status, body } = await addObservable(owner, number, type, value);
      expect([type, value, status]).toEqual([type, value, 400]);
      expect(body).toHaveProperty("error");
    }
    expect((await addObservable(owner, number, "sha256", "abc")).body).toEqual({ error: "SHA-256 must be 64 hexadecimal digits" });
    expect((await addObservable(owner, number, "ip", "  ")).status).toBe(400);
    expect((await observables(owner, number)).body).toEqual({ observables: [] });
    expect((await auditLog(owner, number)).map((e) => e.action)).toEqual(["case.opened"]);
  });

  test("the same Observable written differently on two Cases is one Observable, seen in both", async () => {
    const { owner, open, observable, observables } = await acme();
    const first = await open(owner, "Phishing wave");
    const second = await open(owner, "Beaconing host");
    const a = await observable(owner, first, "domain", "invoice-portal.biz");
    const b = await observable(owner, second, "domain", "INVOICE-PORTAL[.]biz");
    expect(b.id).toBe(a.id);
    expect(b.seenIn).toEqual([{ number: first, title: "Phishing wave" }]);
    const listed = await observables(owner, first);
    expect("observables" in listed.body && listed.body.observables[0]?.seenIn).toEqual([{ number: second, title: "Beaconing host" }]);
  });

  test("the same value as a different type is a different Observable", async () => {
    const { owner, open, observable } = await acme();
    const number = await open();
    const md5 = await observable(owner, number, "md5", "d41d8cd98f00b204e9800998ecf8427e");
    const sha = await observable(owner, number, "domain", "d41d8cd98f00b204e9800998ecf8427e.example");
    expect(md5.id).not.toBe(sha.id);
  });

  test("adding an Observable already on the Case changes nothing", async () => {
    const { owner, ana, open, addObservable, observables, auditLog } = await acme();
    const number = await open();
    const first = await addObservable(owner, number, "ip", "185.220.101.4");
    const again = await addObservable(ana, number, "ip", "185.220.101.004");
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const listed = await observables(owner, number);
    expect("observables" in listed.body && listed.body.observables).toHaveLength(1);
    expect((await auditLog(owner, number)).filter((e) => e.action === "observable.linked")).toHaveLength(1);
  });

  test("Observables list in the order they were added", async () => {
    const { t, owner, open, observable, observables } = await acme();
    const number = await open();
    const first = await observable(owner, number, "ip", "185.220.101.4");
    t.clock.advance(1000);
    const second = await observable(owner, number, "email", "billing@invoice-portal.biz");
    const listed = await observables(owner, number);
    expect("observables" in listed.body && listed.body.observables.map((o) => o.id)).toEqual([first.id, second.id]);
  });
});

describe("Adding Assets", () => {
  test("a Member adds a host and an account; identifiers keep how they were first written", async () => {
    const { owner, ana, open, asset, assets } = await acme();
    const first = await open(owner, "Beaconing host");
    const second = await open(owner, "Credential stuffing");
    const host = await asset(ana, first, "host", " FIN-LT-0231 ");
    expect(host).toMatchObject({ type: "host", value: "FIN-LT-0231", linkedBy: { name: "Ana Analyst" }, seenIn: [] });
    const again = await asset(ana, second, "host", "fin-lt-0231.");
    expect(again).toMatchObject({ id: host.id, value: "FIN-LT-0231", seenIn: [{ number: first, title: "Beaconing host" }] });
    const account = await asset(ana, second, "account", "d.howe");
    expect(account.id).not.toBe(host.id);
    const listed = await assets(owner, second);
    expect("assets" in listed.body && listed.body.assets.map((a) => a.value)).toEqual(["FIN-LT-0231", "d.howe"]);
  });

  test("a host and an account with the same name are different Assets", async () => {
    const { owner, open, asset } = await acme();
    const number = await open();
    const host = await asset(owner, number, "host", "svc-backup");
    const account = await asset(owner, number, "account", "svc-backup");
    expect(host.id).not.toBe(account.id);
  });

  test("an identifier is required", async () => {
    const { owner, open, addAsset } = await acme();
    const number = await open();
    expect((await addAsset(owner, number, "host", "   ")).status).toBe(400);
  });
});

describe("Linking and unlinking are in the Audit Log", () => {
  test("adding and unlinking an Observable record who did it and what it was", async () => {
    const { t, ana, ben, userId, open, observable, unlinkObservable, observables, auditLog } = await acme();
    const number = await open();
    const added = await observable(ana, number, "domain", "invoice-portal[.]biz");
    t.clock.advance(1000);
    const { status, body } = await unlinkObservable(ben, number, added.id);
    expect(status).toBe(200);
    expect(body).toEqual({ observables: [] });
    expect((await observables(ana, number)).body).toEqual({ observables: [] });
    const entries = await auditLog(ana, number);
    expect(entries.slice(0, 2)).toEqual([
      {
        id: expect.any(String),
        occurredAt: t.clock.now().toISOString(),
        actor: { type: "member", id: await userId(ben), name: "Ben Analyst" },
        action: "observable.unlinked",
        target: "Domain invoice-portal.biz",
        before: null,
        after: null,
      },
      {
        id: expect.any(String),
        occurredAt: new Date(t.clock.now().getTime() - 1000).toISOString(),
        actor: { type: "member", id: await userId(ana), name: "Ana Analyst" },
        action: "observable.linked",
        target: "Domain invoice-portal.biz",
        before: null,
        after: null,
      },
    ]);
  });

  test("adding and unlinking an Asset are recorded too", async () => {
    const { owner, open, asset, unlinkAsset, auditLog } = await acme();
    const number = await open();
    const added = await asset(owner, number, "account", "d.howe");
    expect((await unlinkAsset(owner, number, added.id)).body).toEqual({ assets: [] });
    expect((await auditLog(owner, number)).slice(0, 2).map((e) => [e.action, e.target])).toEqual([
      ["asset.unlinked", "Account d.howe"],
      ["asset.linked", "Account d.howe"],
    ]);
  });

  test("unlinking from one Case leaves it on others; it can be linked again", async () => {
    const { owner, open, observable, unlinkObservable, observables, auditLog } = await acme();
    const first = await open(owner, "Phishing wave");
    const second = await open(owner, "Beaconing host");
    const added = await observable(owner, first, "ip", "185.220.101.4");
    await observable(owner, second, "ip", "185.220.101.4");
    await unlinkObservable(owner, first, added.id);
    const remaining = await observables(owner, second);
    expect("observables" in remaining.body && remaining.body.observables[0]).toMatchObject({ id: added.id, seenIn: [] });
    const relinked = await observable(owner, first, "ip", "185.220.101.4");
    expect(relinked).toMatchObject({ id: added.id, seenIn: [{ number: second }] });
    expect((await auditLog(owner, first)).slice(0, 3).map((e) => e.action)).toEqual([
      "observable.linked",
      "observable.unlinked",
      "observable.linked",
    ]);
  });

  test("unlinking something not on the Case is not found, and nothing is recorded", async () => {
    const { owner, open, observable, unlinkObservable, unlinkAsset, auditLog } = await acme();
    const number = await open();
    const other = await open();
    const elsewhere = await observable(owner, other, "ip", "185.220.101.4");
    expect((await unlinkObservable(owner, number, elsewhere.id)).status).toBe(404);
    expect((await unlinkObservable(owner, number, "missing")).status).toBe(404);
    // An Observable's id is not an Asset's.
    expect((await unlinkAsset(owner, other, elsewhere.id)).status).toBe(404);
    expect((await auditLog(owner, number)).map((e) => e.action)).toEqual(["case.opened"]);
  });

  test("unlinking twice: the second time it is no longer linked", async () => {
    const { owner, open, asset, unlinkAsset } = await acme();
    const number = await open();
    const added = await asset(owner, number, "host", "FIN-LT-0231");
    expect((await unlinkAsset(owner, number, added.id)).status).toBe(200);
    expect((await unlinkAsset(owner, number, added.id)).status).toBe(404);
  });
});

describe("Seen in other Cases lists only Cases the actor can see", () => {
  test("an Analyst not assigned to a Restricted Case doesn't see it listed; an Admin and its Assignee do", async () => {
    const { owner, ana, ben, open, observable, observables, asset, assets, restrictedToAna } = await acme();
    const restricted = await restrictedToAna("Exec mailbox");
    const visible = await open(owner, "Phishing wave");
    const number = await open(owner, "Beaconing host");
    await observable(ana, restricted, "ip", "185.220.101.4");
    await observable(owner, visible, "ip", "185.220.101.4");
    await asset(ana, restricted, "account", "d.howe");
    await observable(owner, number, "ip", "185.220.101.4");
    await asset(owner, number, "account", "d.howe");

    const seenBy = async (as: typeof ben) => {
      const o = await observables(as, number);
      const a = await assets(as, number);
      return {
        observable: "observables" in o.body ? o.body.observables[0]?.seenIn : null,
        asset: "assets" in a.body ? a.body.assets[0]?.seenIn : null,
      };
    };
    expect(await seenBy(ben)).toEqual({ observable: [{ number: visible, title: "Phishing wave" }], asset: [] });
    const all = {
      observable: [
        { number: visible, title: "Phishing wave" },
        { number: restricted, title: "Exec mailbox" },
      ],
      asset: [{ number: restricted, title: "Exec mailbox" }],
    };
    expect(await seenBy(owner)).toEqual(all);
    expect(await seenBy(ana)).toEqual(all);
  });

  test("another Organization's Observables are its own, and its Cases are never listed", async () => {
    const { t, owner, open, observable } = await acme();
    const number = await open(owner);
    const ours = await observable(owner, number, "ip", "185.220.101.4");
    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    const theirCase = (await (await globex.api.cases.$post({ json: { title: "Theirs", caseType: "malware", severity: "low" } })).json()) as {
      case: { number: number };
    };
    const theirs = await observable(globex, theirCase.case.number, "ip", "185.220.101.4");
    expect(theirs.id).not.toBe(ours.id);
    expect(theirs.seenIn).toEqual([]);
    expect((await observable(owner, number, "ip", "185.220.101.4")).seenIn).toEqual([]);
  });

  test("Cases it has been unlinked from aren't listed", async () => {
    const { owner, open, observable, unlinkObservable } = await acme();
    const first = await open();
    const second = await open();
    const added = await observable(owner, first, "sha256", "a".repeat(64));
    await unlinkObservable(owner, first, added.id);
    expect((await observable(owner, second, "sha256", "a".repeat(64))).seenIn).toEqual([]);
  });
});

describe("Only people who can see the Case work its Observables and Assets", () => {
  test("an Analyst not assigned to a Restricted Case gets not found everywhere, and nothing changes", async () => {
    const { owner, ana, ben, observable, addObservable, observables, unlinkObservable, addAsset, assets, auditLog, restrictedToAna } =
      await acme();
    const number = await restrictedToAna();
    const added = await observable(ana, number, "ip", "185.220.101.4");
    expect((await observables(ben, number)).status).toBe(404);
    expect((await assets(ben, number)).status).toBe(404);
    expect((await addObservable(ben, number, "ip", "1.2.3.4")).status).toBe(404);
    expect((await addAsset(ben, number, "host", "x")).status).toBe(404);
    expect((await unlinkObservable(ben, number, added.id)).status).toBe(404);
    expect((await auditLog(owner, number)).filter((e) => e.action.startsWith("observable") || e.action.startsWith("asset"))).toHaveLength(1);
  });

  test("a Closed Case's Observables and Assets can be read but not changed", async () => {
    const { owner, open, observable, addObservable, observables, unlinkObservable, addAsset } = await acme();
    const number = await open();
    const added = await observable(owner, number, "ip", "185.220.101.4");
    await owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "true_positive" } });
    expect((await addObservable(owner, number, "ip", "1.2.3.4")).status).toBe(409);
    expect((await addAsset(owner, number, "host", "x")).status).toBe(409);
    expect((await unlinkObservable(owner, number, added.id)).status).toBe(409);
    expect((await observables(owner, number)).body).toMatchObject({ observables: [{ id: added.id }] });
  });
});

describe("Live updates", () => {
  test("linking announces the change to this Case and every other Case it's on", async () => {
    const { t, owner, ben, open, observable, unlinkObservable } = await acme();
    const first = await open();
    const second = await open();
    await observable(owner, first, "ip", "185.220.101.4");
    const live = await t.connect(ben);
    const added = await observable(owner, second, "ip", "185.220.101.4");
    const heard = [await live.next(), await live.next()];
    expect(heard).toContainEqual({ type: "case", number: first });
    expect(heard).toContainEqual({ type: "case", number: second });
    await unlinkObservable(owner, second, added.id);
    const after = [await live.next(), await live.next()];
    expect(after).toContainEqual({ type: "case", number: first });
    expect(after).toContainEqual({ type: "case", number: second });
  });
});

describe("Nothing is hard-deleted", () => {
  test("the database refuses to alter or delete Observables and Assets, or delete their links", async () => {
    const { t, owner, open, observable, asset } = await acme();
    const number = await open();
    await observable(owner, number, "ip", "185.220.101.4");
    await asset(owner, number, "host", "FIN-LT-0231");
    const { db } = t.deps;
    for (const table of ["observables", "assets"]) {
      expect(await dbError(db.execute(sql.raw(`UPDATE ${table} SET value = 'x'`)))).toMatch(/cannot be altered or deleted/);
      expect(await dbError(db.execute(sql.raw(`DELETE FROM ${table}`)))).toMatch(/cannot be altered or deleted/);
      expect(await dbError(db.execute(sql.raw(`TRUNCATE ${table} CASCADE`)))).toMatch(/cannot be altered or deleted/);
    }
    for (const table of ["case_observables", "case_assets"]) {
      expect(await dbError(db.execute(sql.raw(`DELETE FROM ${table}`)))).toMatch(/cannot be deleted/);
      expect(await dbError(db.execute(sql.raw(`TRUNCATE ${table}`)))).toMatch(/cannot be deleted/);
    }
  });
});
