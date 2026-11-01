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
  type LinkType = Parameters<Member["api"]["cases"][":number"]["links"]["$post"]>[0]["json"]["type"];

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

  const view = async (as: Member, number: number) => {
    const res = await as.api.cases[":number"].$get({ param: param(number) });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not view C-${number}: ${res.status}`);
    return body.case;
  };

  const link = async (as: Member, number: number, type: LinkType, target: number) => {
    const res = await as.api.cases[":number"].links.$post({ param: param(number), json: { type, case: target } });
    return { status: res.status, body: await res.json() };
  };
  const links = async (as: Member, number: number) => {
    const res = await as.api.cases[":number"].links.$get({ param: param(number) });
    return { status: res.status, body: await res.json() };
  };
  const unlink = async (as: Member, number: number, id: string) => {
    const res = await as.api.cases[":number"].links[":id"].$delete({ param: { ...param(number), id } });
    return { status: res.status, body: await res.json() };
  };

  const addTag = async (as: Member, number: number, tag: string) => {
    const res = await as.api.cases[":number"].tags.$post({ param: param(number), json: { tag } });
    return { status: res.status, body: await res.json() };
  };
  const removeTag = async (as: Member, number: number, tag: string) => {
    const res = await as.api.cases[":number"].tags[":tag"].$delete({ param: { ...param(number), tag } });
    return { status: res.status, body: await res.json() };
  };
  const list = async (as: Member, query: { view?: "open" | "closed"; tag?: string }) => {
    const res = await as.api.cases.$get({ query });
    return { status: res.status, body: await res.json() };
  };
  const listed = async (as: Member, query: { view?: "open" | "closed"; tag?: string }) => {
    const { body } = await list(as, query);
    if (!("cases" in body)) throw new Error("Could not list Cases");
    return body.cases.map((c) => c.number);
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

  return { t, owner, ana, ben, userId, open, view, link, links, unlink, addTag, removeTag, list, listed, auditLog, restrictedToAna };
}

describe("Linking Cases", () => {
  test("a Member links two Cases; each lists the link from its own side, with who made it and when", async () => {
    const { t, ana, ben, userId, open, link, links } = await acme();
    const parent = await open(ana, "Phishing campaign");
    const child = await open(ana, "Clicked link — finance");
    const { status, body } = await link(ana, child, "child_of", parent);
    expect(status).toBe(201);
    const linkedBy = { id: await userId(ana), name: "Ana Analyst" };
    const linkedAt = t.clock.now().toISOString();
    expect(body).toEqual({
      links: [
        {
          id: expect.any(String),
          side: "child_of",
          case: { number: parent, title: "Phishing campaign", status: "new", resolution: null },
          linkedBy,
          linkedAt,
        },
      ],
      closed: false,
    });
    expect((await links(ben, parent)).body).toEqual({
      links: [
        {
          id: expect.any(String),
          side: "parent_of",
          case: { number: child, title: "Clicked link — finance", status: "new", resolution: null },
          linkedBy,
          linkedAt,
        },
      ],
    });
  });

  test("Related, Parent of and Duplicate of read from both sides", async () => {
    const { owner, open, link, links } = await acme();
    const a = await open();
    const b = await open();
    const c = await open();
    const d = await open();
    await link(owner, a, "related", b);
    await link(owner, a, "parent_of", c);
    await link(owner, d, "duplicate_of", a);
    const sides = async (n: number) => {
      const { body } = await links(owner, n);
      if (!("links" in body)) throw new Error("No links");
      return body.links.map((l) => [l.side, l.case.number]);
    };
    expect(await sides(a)).toEqual([
      ["related", b],
      ["parent_of", c],
      ["duplicated_by", d],
    ]);
    expect(await sides(b)).toEqual([["related", a]]);
    expect(await sides(c)).toEqual([["child_of", a]]);
    expect(await sides(d)).toEqual([["duplicate_of", a]]);
  });

  test("linking is recorded in both Cases' Audit Logs, naming the other Case", async () => {
    const { owner, open, link, auditLog } = await acme();
    const a = await open();
    const b = await open();
    await link(owner, a, "parent_of", b);
    const [onA] = await auditLog(owner, a);
    const [onB] = await auditLog(owner, b);
    expect(onA).toMatchObject({ action: "case_link.added", target: `Parent of C-${b}`, actor: { name: "Olive Owner" } });
    expect(onB).toMatchObject({ action: "case_link.added", target: `Child of C-${a}`, actor: { name: "Olive Owner" } });
  });

  test("two Cases have at most one link at a time, either way round", async () => {
    const { owner, open, link } = await acme();
    const a = await open();
    const b = await open();
    expect((await link(owner, a, "related", b)).status).toBe(201);
    const again = await link(owner, b, "parent_of", a);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: `C-${b} and C-${a} are already linked; remove that link first` });
  });

  test("a Case can't be linked to itself, or to a Case that doesn't exist", async () => {
    const { owner, open, link } = await acme();
    const a = await open();
    expect(await link(owner, a, "related", a)).toEqual({ status: 400, body: { error: "A Case can't be linked to itself" } });
    expect(await link(owner, a, "related", 999)).toEqual({ status: 400, body: { error: "There is no Case C-999 you can see" } });
  });

  test("a Closed Case can't be linked from, but can be linked to", async () => {
    const { owner, open, link, view } = await acme();
    const closed = await open(owner, "Original");
    await owner.api.cases[":number"].close.$post({ param: param(closed), json: { resolution: "true_positive" } });
    const fresh = await open(owner, "Reported again");
    expect((await link(owner, closed, "related", fresh)).status).toBe(409);
    expect((await link(owner, fresh, "related", closed)).status).toBe(201);
    expect((await view(owner, closed)).status).toBe("closed");
  });

  test("a Case the actor can't see is 404", async () => {
    const { ben, link, links, restrictedToAna, open } = await acme();
    const hidden = await restrictedToAna();
    const other = await open();
    expect((await links(ben, hidden)).status).toBe(404);
    expect((await link(ben, hidden, "related", other)).status).toBe(404);
  });
});

describe("Duplicate of", () => {
  test("marking a Case Duplicate of another closes it with Resolution Duplicate", async () => {
    const { t, owner, ana, userId, open, link, view, auditLog } = await acme();
    const original = await open(ana, "Credential phishing — finance");
    const dup = await open(ana, "Phishing — payroll lure");
    await owner.api.cases[":number"].$patch({ param: param(dup), json: { status: "triage" } });
    const { status, body } = await link(ana, dup, "duplicate_of", original);
    expect(status).toBe(201);
    expect(body).toMatchObject({ closed: true });
    const closed = await view(ana, dup);
    expect(closed).toMatchObject({
      status: "closed",
      resolution: "duplicate",
      closed: { by: { id: await userId(ana), name: "Ana Analyst" }, at: t.clock.now().toISOString() },
    });
    expect((await view(ana, original)).status).toBe("new");
    const actions = (await auditLog(ana, dup)).map((e) => [e.action, e.target, e.before, e.after]);
    expect(actions.slice(0, 2)).toEqual([
      ["case.closed", null, "triage", "duplicate"],
      ["case_link.added", `Duplicate of C-${original}`, null, null],
    ]);
  });

  test("other link types leave both Cases open", async () => {
    const { owner, open, link, view } = await acme();
    const a = await open();
    const b = await open();
    expect((await link(owner, a, "related", b)).body).toMatchObject({ closed: false });
    expect((await view(owner, a)).status).toBe("new");
  });

  test("removing a Duplicate-of link doesn't reopen the Case", async () => {
    const { owner, open, link, links, unlink, view } = await acme();
    const original = await open();
    const dup = await open();
    await link(owner, dup, "duplicate_of", original);
    const { body } = await links(owner, original);
    if (!("links" in body)) throw new Error("No links");
    const removed = await unlink(owner, original, body.links[0]!.id);
    expect(removed).toEqual({ status: 200, body: { links: [] } });
    expect((await view(owner, dup)).status).toBe("closed");
  });
});

describe("Removing links", () => {
  test("either Case removes the link; both Audit Logs record it and neither lists it", async () => {
    const { owner, ben, open, link, links, unlink, auditLog } = await acme();
    const a = await open();
    const b = await open();
    const made = await link(owner, a, "parent_of", b);
    if (!("links" in made.body)) throw new Error("Not linked");
    const removed = await unlink(ben, b, made.body.links[0]!.id);
    expect(removed).toEqual({ status: 200, body: { links: [] } });
    expect((await links(owner, a)).body).toEqual({ links: [] });
    expect((await auditLog(owner, a))[0]).toMatchObject({ action: "case_link.removed", target: `Parent of C-${b}`, actor: { name: "Ben Analyst" } });
    expect((await auditLog(owner, b))[0]).toMatchObject({ action: "case_link.removed", target: `Child of C-${a}` });
  });

  test("a removed link can be made again, and the row is kept", async () => {
    const { t, owner, open, link, unlink } = await acme();
    const a = await open();
    const b = await open();
    const made = await link(owner, a, "related", b);
    if (!("links" in made.body)) throw new Error("Not linked");
    await unlink(owner, a, made.body.links[0]!.id);
    expect((await link(owner, a, "parent_of", b)).status).toBe(201);
    const [{ n }] = (await t.deps.db.execute(sql`select count(*)::int as n from case_links`)) as unknown as [{ n: number }];
    expect(n).toBe(2);
  });

  test("an unknown or already-removed link is 404, and a Closed Case can't remove links", async () => {
    const { owner, open, link, unlink } = await acme();
    const a = await open();
    const b = await open();
    expect((await unlink(owner, a, "nope")).status).toBe(404);
    const made = await link(owner, a, "related", b);
    if (!("links" in made.body)) throw new Error("Not linked");
    const id = made.body.links[0]!.id;
    await owner.api.cases[":number"].close.$post({ param: param(a), json: { resolution: "benign" } });
    expect((await unlink(owner, a, id)).status).toBe(409);
    expect((await unlink(owner, b, id)).status).toBe(200);
    expect((await unlink(owner, b, id)).status).toBe(404);
  });

  test("the database refuses to delete links", async () => {
    const { t, owner, open, link } = await acme();
    await link(owner, await open(), "related", await open());
    expect(await dbError(t.deps.db.execute(sql`delete from case_links`))).toContain("cannot be deleted");
    expect(await dbError(t.deps.db.execute(sql`truncate case_links`))).toContain("cannot be deleted");
  });
});

describe("Linked Cases the actor can't see", () => {
  test("a link to a Restricted Case is listed only for those who can see that Case", async () => {
    const { owner, ana, ben, open, link, links, restrictedToAna } = await acme();
    const hidden = await restrictedToAna();
    const visible = await open(owner, "Public matter");
    await link(ana, visible, "related", hidden);
    const numbers = async (as: typeof owner) => {
      const { body } = await links(as, visible);
      if (!("links" in body)) throw new Error("No links");
      return body.links.map((l) => l.case.number);
    };
    expect(await numbers(ana)).toEqual([hidden]);
    expect(await numbers(owner)).toEqual([hidden]);
    expect(await numbers(ben)).toEqual([]);
  });

  test("a Case the actor can't see can't be linked to, and the refusal doesn't say whether it exists", async () => {
    const { ben, open, link, restrictedToAna } = await acme();
    const hidden = await restrictedToAna();
    const mine = await open();
    expect(await link(ben, mine, "related", hidden)).toEqual({ status: 400, body: { error: `There is no Case C-${hidden} you can see` } });
  });

  test("a link to a Case the actor can't see can't be removed by them", async () => {
    const { owner, ana, ben, open, link, links, unlink, restrictedToAna } = await acme();
    const hidden = await restrictedToAna();
    const visible = await open();
    await link(ana, visible, "related", hidden);
    const { body } = await links(owner, visible);
    if (!("links" in body)) throw new Error("No links");
    expect((await unlink(ben, visible, body.links[0]!.id)).status).toBe(404);
    expect((await links(ana, visible)).body).toMatchObject({ links: [{ case: { number: hidden } }] });
  });

  test("Cases in another Organization can't be linked", async () => {
    const { t, owner, open, link } = await acme();
    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    const openTheirs = async () => {
      const body = await (await globex.api.cases.$post({ json: { title: "Theirs", caseType: "other", severity: "low" } })).json();
      if (!("case" in body)) throw new Error("Not opened");
      return body.case.number;
    };
    await openTheirs();
    const theirs = await openTheirs();
    const mine = await open();
    expect(await link(owner, mine, "related", theirs)).toEqual({ status: 400, body: { error: `There is no Case C-${theirs} you can see` } });
  });

  test("linking and removing a link signal both Cases", async () => {
    const { t, owner, ben, open, link, unlink } = await acme();
    const a = await open();
    const b = await open();
    const live = await t.connect(ben);
    const made = await link(owner, a, "related", b);
    if (!("links" in made.body)) throw new Error("Not linked");
    const heard = [await live.next(), await live.next()];
    expect(heard).toContainEqual({ type: "case", number: a });
    expect(heard).toContainEqual({ type: "case", number: b });
    await unlink(owner, b, made.body.links[0]!.id);
    const after = [await live.next(), await live.next()];
    expect(after).toContainEqual({ type: "case", number: a });
    expect(after).toContainEqual({ type: "case", number: b });
  });
});

describe("Tags", () => {
  test("a Member adds Tags; they are normalised, listed alphabetically on the Case and in the list", async () => {
    const { owner, ana, open, addTag, view, list } = await acme();
    const number = await open();
    expect(await addTag(ana, number, "#Finance")).toEqual({ status: 201, body: { tags: ["finance"] } });
    expect(await addTag(ana, number, "  legal hold ")).toEqual({ status: 201, body: { tags: ["finance", "legal-hold"] } });
    expect(await addTag(ana, number, "BEC")).toEqual({ status: 201, body: { tags: ["bec", "finance", "legal-hold"] } });
    expect((await view(owner, number)).tags).toEqual(["bec", "finance", "legal-hold"]);
    const { body } = await list(owner, {});
    if (!("cases" in body)) throw new Error("No list");
    expect(body.cases[0]!.tags).toEqual(["bec", "finance", "legal-hold"]);
  });

  test("adding a Tag the Case already has changes nothing", async () => {
    const { owner, open, addTag, auditLog } = await acme();
    const number = await open();
    await addTag(owner, number, "bec");
    expect(await addTag(owner, number, "#BEC")).toEqual({ status: 200, body: { tags: ["bec"] } });
    expect((await auditLog(owner, number)).filter((e) => e.action === "tag.added")).toHaveLength(1);
  });

  test("invalid Tags are refused", async () => {
    const { owner, open, addTag } = await acme();
    const number = await open();
    for (const bad of ["", "#", "-leading", "a/b", "x".repeat(51)]) {
      const res = await addTag(owner, number, bad);
      expect(res.status).toBe(400);
    }
  });

  test("Tags are removed, and adding and removing are recorded in the Audit Log", async () => {
    const { owner, ben, open, addTag, removeTag, auditLog, view } = await acme();
    const number = await open();
    await addTag(owner, number, "bec");
    await addTag(owner, number, "finance");
    expect(await removeTag(ben, number, "BEC")).toEqual({ status: 200, body: { tags: ["finance"] } });
    expect((await view(owner, number)).tags).toEqual(["finance"]);
    expect(await removeTag(ben, number, "bec")).toEqual({ status: 404, body: { error: "This Case doesn't have that Tag" } });
    const entries = (await auditLog(owner, number)).map((e) => [e.action, e.target, e.actor.name]);
    expect(entries.slice(0, 3)).toEqual([
      ["tag.removed", "#bec", "Ben Analyst"],
      ["tag.added", "#finance", "Olive Owner"],
      ["tag.added", "#bec", "Olive Owner"],
    ]);
  });

  test("a Closed Case's Tags can't change, and a Case the actor can't see is 404", async () => {
    const { owner, ben, open, addTag, removeTag, restrictedToAna } = await acme();
    const number = await open();
    await addTag(owner, number, "bec");
    await owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "benign" } });
    expect((await addTag(owner, number, "finance")).status).toBe(409);
    expect((await removeTag(owner, number, "bec")).status).toBe(409);
    const hidden = await restrictedToAna();
    expect((await addTag(ben, hidden, "x")).status).toBe(404);
  });

  test("Cases are filtered by Tag, in any view", async () => {
    const { owner, open, addTag, removeTag, listed, list } = await acme();
    const a = await open();
    const b = await open();
    const c = await open();
    await addTag(owner, a, "bec");
    await addTag(owner, b, "bec");
    await addTag(owner, c, "cloud");
    await owner.api.cases[":number"].close.$post({ param: param(b), json: { resolution: "benign" } });
    expect(await listed(owner, { view: "open", tag: "#BEC" })).toEqual([a]);
    expect(await listed(owner, { view: "closed", tag: "bec" })).toEqual([b]);
    expect(await listed(owner, { view: "open", tag: "cloud" })).toEqual([c]);
    await removeTag(owner, c, "cloud");
    expect(await listed(owner, { view: "open", tag: "cloud" })).toEqual([]);
    expect((await list(owner, { tag: "not/valid" })).status).toBe(400);
  });

  test("the Tags in use are those on Cases the actor can see", async () => {
    const { owner, ben, open, addTag, restrictedToAna } = await acme();
    const a = await open();
    const b = await open();
    const hidden = await restrictedToAna();
    await addTag(owner, a, "bec");
    await addTag(owner, b, "bec");
    await addTag(owner, hidden, "legal-hold");
    const inUse = async (as: typeof owner) => (await (await as.api.cases.tags.$get()).json()).tags;
    expect(await inUse(owner)).toEqual([
      { tag: "bec", cases: 2 },
      { tag: "legal-hold", cases: 1 },
    ]);
    expect(await inUse(ben)).toEqual([{ tag: "bec", cases: 2 }]);
  });

  test("the database refuses to delete Tags", async () => {
    const { t, owner, open, addTag } = await acme();
    await addTag(owner, await open(), "bec");
    expect(await dbError(t.deps.db.execute(sql`delete from case_tags`))).toContain("cannot be deleted");
  });
});
