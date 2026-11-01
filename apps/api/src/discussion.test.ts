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

/** Acme Security: its Owner, Adam (Admin), Ana and Ben (Analysts), signed in, and a Case to work. */
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
  const ben = await join("ben@acme.example", "analyst", "Ben Analyst");
  type Member = typeof owner;

  const userId = async (as: Member) => {
    const me = await (await as.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  };
  const mention = async (as: Member) => `<@${await userId(as)}>`;

  const open = async (as: Member = owner) => {
    const res = await as.api.cases.$post({ json: { title: "Suspicious PowerShell", caseType: "malware", severity: "critical" } });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case.number;
  };

  const discussion = (as: Member) => as.api.cases[":number"].discussion;

  const post = async (as: Member, number: number, body: string) => {
    const res = await discussion(as).$post({ param: param(number), json: { body } });
    return { status: res.status, body: await res.json() };
  };
  /** Posts a message that must succeed, and returns it. */
  const message = async (as: Member, number: number, body: string) => {
    const res = await post(as, number, body);
    if (res.status !== 201 || !("message" in res.body)) throw new Error(`Could not post: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.message;
  };
  const edit = async (as: Member, number: number, id: string, body: string) => {
    const res = await discussion(as)[":id"].$patch({ param: { ...param(number), id }, json: { body } });
    return { status: res.status, body: await res.json() };
  };
  const retract = async (as: Member, number: number, id: string) => {
    const res = await discussion(as)[":id"].retract.$post({ param: { ...param(number), id } });
    return { status: res.status, body: await res.json() };
  };
  const list = async (as: Member, number: number) => {
    const res = await discussion(as).$get({ param: param(number) });
    return { status: res.status, body: await res.json() };
  };
  const mentionable = async (as: Member, number: number) => {
    const res = await discussion(as).mentionable.$get({ param: param(number) });
    const body = await res.json();
    return { status: res.status, names: "people" in body ? body.people.map((p) => p.name) : null };
  };

  const auditLog = async (as: Member, number: number) => {
    const body = await (await as.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };

  const change = (as: Member, number: number, json: { assigneeId?: string | null; restricted?: boolean }) =>
    as.api.cases[":number"].$patch({ param: param(number), json });

  /** A Case only the Owner, Adam and Ana (its Assignee) can see. */
  const restrictedToAna = async () => {
    const number = await open();
    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    return number;
  };

  /** Who is recorded as mentioned, by name, in the order they were. */
  const mentionsStored = async () => {
    const rows = await t.deps.db.execute<{ name: string; by: string; at: Date | string }>(sql`
      select u.name, b.name as by, m.mentioned_at as at from discussion_mentions m
      join "user" u on u.id = m.user_id join "user" b on b.id = m.mentioned_by_id
      order by m.mentioned_at, u.name`);
    return rows.map((r) => ({ name: r.name, by: r.by, at: new Date(r.at).toISOString() }));
  };

  return {
    t,
    owner,
    admin,
    ana,
    ben,
    userId,
    mention,
    open,
    post,
    message,
    edit,
    retract,
    list,
    mentionable,
    auditLog,
    change,
    restrictedToAna,
    mentionsStored,
  };
}

describe("Posting messages", () => {
  test("anyone who can see the Case posts; the Discussion lists messages oldest first", async () => {
    const { t, owner, ana, ben, userId, open, message, list } = await acme();
    const number = await open();
    const first = await message(ana, number, "Contained. Can someone grab a memory image before reboot?");
    t.clock.advance(60_000);
    const second = await message(ben, number, "On it.");
    expect(first).toEqual({
      id: expect.any(String),
      author: { id: await userId(ana), name: "Ana Analyst" },
      body: "Contained. Can someone grab a memory image before reboot?",
      mentions: [],
      postedAt: "2026-01-01T09:00:00.000Z",
      editedAt: null,
      retractedAt: null,
      internal: false,
      can: { edit: true, retract: true },
    });
    const { status, body } = await list(owner, number);
    expect(status).toBe(200);
    expect("messages" in body && body.messages.map((m) => [m.author.name, m.body, m.can])).toEqual([
      ["Ana Analyst", first.body, { edit: false, retract: false }],
      ["Ben Analyst", second.body, { edit: false, retract: false }],
    ]);
  });

  test("messages posted at the same instant keep the order they were posted in", async () => {
    const { owner, open, message, list } = await acme();
    const number = await open();
    for (const text of ["one", "two", "three", "four"]) await message(owner, number, text);
    const { body } = await list(owner, number);
    expect("messages" in body && body.messages.map((m) => m.body)).toEqual(["one", "two", "three", "four"]);
  });

  test("an empty message is refused", async () => {
    const { owner, open, post } = await acme();
    const number = await open();
    expect((await post(owner, number, "   ")).status).toBe(400);
    expect((await post(owner, number, "x".repeat(10_001))).status).toBe(400);
  });

  test("posting is recorded in the Audit Log, with mentions written as names", async () => {
    const { t, ana, ben, userId, mention, open, message, auditLog } = await acme();
    const number = await open();
    await message(ana, number, `${await mention(ben)} can you grab a memory image?`);
    expect((await auditLog(ana, number))[0]).toEqual({
      id: expect.any(String),
      occurredAt: t.clock.now().toISOString(),
      actor: { type: "member", id: await userId(ana), name: "Ana Analyst" },
      action: "discussion.message_posted",
      target: null,
      before: null,
      after: "@Ben Analyst can you grab a memory image?",
    });
  });
});

describe("Editing and retracting messages", () => {
  test("the author edits a message; it shows as edited and the Audit Log keeps the original", async () => {
    const { t, ana, ben, mention, open, message, edit, auditLog } = await acme();
    const number = await open();
    const posted = await message(ana, number, "Host is FIN-LT-0198");
    t.clock.advance(60_000);
    const { status, body } = await edit(ana, number, posted.id, `Host is FIN-LT-0231, ${await mention(ben)}`);
    expect(status).toBe(200);
    expect("message" in body && body.message).toMatchObject({
      body: `Host is FIN-LT-0231, ${await mention(ben)}`,
      mentions: [{ name: "Ben Analyst" }],
      postedAt: "2026-01-01T09:00:00.000Z",
      editedAt: "2026-01-01T09:01:00.000Z",
    });
    expect((await auditLog(ana, number))[0]).toMatchObject({
      action: "discussion.message_edited",
      before: "Host is FIN-LT-0198",
      after: "Host is FIN-LT-0231, @Ben Analyst",
    });
  });

  test("an edit that changes nothing records nothing", async () => {
    const { ana, open, message, edit, auditLog } = await acme();
    const number = await open();
    const posted = await message(ana, number, "Same words");
    const before = await auditLog(ana, number);
    const { status, body } = await edit(ana, number, posted.id, "Same words");
    expect(status).toBe(200);
    expect("message" in body && body.message.editedAt).toBeNull();
    expect(await auditLog(ana, number)).toEqual(before);
  });

  test("the author retracts a message; its text is withdrawn and the Audit Log keeps it", async () => {
    const { t, ana, ben, mention, open, message, retract, list, auditLog } = await acme();
    const number = await open();
    const posted = await message(ana, number, `Lateral movement to FIN-LT-0198, ${await mention(ben)}`);
    t.clock.advance(60_000);
    const { status, body } = await retract(ana, number, posted.id);
    expect(status).toBe(200);
    const retracted = {
      id: posted.id,
      author: posted.author,
      body: null,
      mentions: [],
      postedAt: posted.postedAt,
      editedAt: null,
      retractedAt: "2026-01-01T09:01:00.000Z",
      internal: false,
      can: { edit: false, retract: false },
    };
    expect("message" in body && body.message).toEqual(retracted);
    const listed = await list(ben, number);
    expect("messages" in listed.body && listed.body.messages).toEqual([{ ...retracted }]);
    expect((await auditLog(ana, number))[0]).toMatchObject({
      action: "discussion.message_retracted",
      before: "Lateral movement to FIN-LT-0198, @Ben Analyst",
      after: null,
    });
  });

  test("a retracted message can't be edited or retracted again", async () => {
    const { ana, open, message, edit, retract } = await acme();
    const number = await open();
    const posted = await message(ana, number, "Wrong Case");
    await retract(ana, number, posted.id);
    expect(await edit(ana, number, posted.id, "Edited")).toEqual({ status: 409, body: { error: "This message has been retracted" } });
    expect((await retract(ana, number, posted.id)).status).toBe(409);
  });

  test("nobody else edits or retracts a message, not even the Owner or an Admin", async () => {
    const { owner, admin, ana, ben, open, message, edit, retract, auditLog } = await acme();
    const number = await open();
    const posted = await message(ana, number, "Mine");
    const before = await auditLog(owner, number);
    for (const other of [owner, admin, ben]) {
      expect(await edit(other, number, posted.id, "Theirs")).toEqual({ status: 403, body: { error: "Only its author can edit a message" } });
      expect(await retract(other, number, posted.id)).toEqual({
        status: 403,
        body: { error: "Only its author can retract a message" },
      });
    }
    expect(await auditLog(owner, number)).toEqual(before);
  });

  test("a message on another Case is not found", async () => {
    const { ana, open, message, edit, retract } = await acme();
    const number = await open();
    const other = await open();
    const posted = await message(ana, number, "Here");
    expect((await edit(ana, other, posted.id, "There")).status).toBe(404);
    expect((await retract(ana, other, posted.id)).status).toBe(404);
    expect((await edit(ana, number, "nope", "There")).status).toBe(404);
  });
});

describe("A Closed Case's Discussion is read-only", () => {
  test("posting, editing and retracting are refused until an Admin reopens it", async () => {
    const { owner, ana, open, message, post, edit, retract, list } = await acme();
    const number = await open();
    const posted = await message(ana, number, "Before closing");
    await owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "benign" } });
    const closed = { error: "This Case is Closed and read-only; an Admin can reopen it" };
    expect(await post(ana, number, "After")).toEqual({ status: 409, body: closed });
    expect(await edit(ana, number, posted.id, "After")).toEqual({ status: 409, body: closed });
    expect(await retract(ana, number, posted.id)).toEqual({ status: 409, body: closed });
    expect((await list(ana, number)).status).toBe(200);
    await owner.api.cases[":number"].reopen.$post({ param: param(number) });
    expect((await post(ana, number, "After reopening")).status).toBe(201);
  });
});

describe("Mentions", () => {
  test("everyone in the Organization can be mentioned on a Case that isn't Restricted", async () => {
    const { ana, open, mentionable } = await acme();
    const number = await open();
    expect(await mentionable(ana, number)).toEqual({
      status: 200,
      names: ["Adam Admin", "Ana Analyst", "Ben Analyst", "Olive Owner"],
    });
  });

  test("on a Restricted Case, only people who can see it are offered", async () => {
    const { owner, ana, ben, open, mentionable, change, userId } = await acme();
    const number = await open();
    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    expect((await mentionable(ana, number)).names).toEqual(["Adam Admin", "Ana Analyst", "Olive Owner"]);
    // A Case Role on it counts as assigned.
    const role = await (await owner.api.organization["case-roles"].$post({ json: { name: "Forensics" } })).json();
    if (!("caseRole" in role)) throw new Error("Could not create a Case Role");
    await owner.api.cases[":number"]["case-roles"].$post({
      param: param(number),
      json: { caseRoleId: role.caseRole.id, userId: await userId(ben) },
    });
    expect((await mentionable(ana, number)).names).toEqual(["Adam Admin", "Ana Analyst", "Ben Analyst", "Olive Owner"]);
  });

  test("a mention shows with the person's current name", async () => {
    const { t, ana, ben, mention, open, message, list } = await acme();
    const number = await open();
    const posted = await message(ana, number, `Thanks ${await mention(ben)}!`);
    expect(posted.mentions).toEqual([{ id: expect.any(String), name: "Ben Analyst" }]);
    await t.deps.db.execute(sql`update "user" set name = 'Ben Okafor' where name = 'Ben Analyst'`);
    const { body } = await list(ana, number);
    expect("messages" in body && body.messages[0]?.mentions.map((m) => m.name)).toEqual(["Ben Okafor"]);
  });

  test("mentioning someone who can't see a Restricted Case is refused, and nothing is posted", async () => {
    const { owner, ana, ben, mention, restrictedToAna, post, list, auditLog, mentionsStored } = await acme();
    const number = await restrictedToAna();
    const before = await auditLog(owner, number);
    expect(await post(ana, number, `${await mention(ben)} please look`)).toEqual({
      status: 400,
      body: { error: "Only people who can see the Case can be mentioned" },
    });
    expect((await list(ana, number)).body).toEqual({ messages: [] });
    expect(await auditLog(owner, number)).toEqual(before);
    expect(await mentionsStored()).toEqual([]);
  });

  test("someone outside the Organization, or nobody at all, can't be mentioned", async () => {
    const { t, owner, mention, open, post } = await acme();
    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    const number = await open();
    expect((await post(owner, number, `Hi ${await mention(globex)}`)).status).toBe(400);
    expect((await post(owner, number, "Hi <@nobody>")).status).toBe(400);
  });

  test("a mention never grants access: the person mentioned still can't see a Restricted Case", async () => {
    const { owner, ana, ben, mention, open, message, change, userId, list } = await acme();
    const number = await open();
    await message(ana, number, `${await mention(ben)} FYI`);
    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    expect((await list(ben, number)).status).toBe(404);
    expect((await ben.api.cases[":number"].$get({ param: param(number) })).status).toBe(404);
  });

  test("an edit may keep mentions of people who lost sight of the Case, but not add new ones", async () => {
    const { owner, admin, ana, ben, mention, open, message, edit, change, userId } = await acme();
    const number = await open();
    const posted = await message(ana, number, `${await mention(ben)} FYI`);
    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    expect((await edit(ana, number, posted.id, `${await mention(ben)} FYI, fixed typo`)).status).toBe(200);
    expect((await edit(ana, number, posted.id, `${await mention(ben)} ${await mention(admin)}`)).status).toBe(200);
    const second = await message(ana, number, "Later");
    expect((await edit(ana, number, second.id, `Later ${await mention(ben)}`)).status).toBe(400);
  });

  test("mentions are stored when posted, and when an edit adds someone", async () => {
    const { t, owner, admin, ana, ben, mention, open, message, edit, mentionsStored } = await acme();
    const number = await open();
    const posted = await message(ana, number, `${await mention(ben)} and ${await mention(ben)}, look`);
    expect(await mentionsStored()).toEqual([{ name: "Ben Analyst", by: "Ana Analyst", at: "2026-01-01T09:00:00.000Z" }]);
    t.clock.advance(60_000);
    // Ben stays mentioned; Adam and the Owner are added.
    await edit(ana, number, posted.id, `${await mention(ben)}, ${await mention(admin)} and ${await mention(owner)}, look`);
    // Dropping a mention and adding it back doesn't mention them again.
    await edit(ana, number, posted.id, "look");
    await edit(ana, number, posted.id, `${await mention(admin)}, look`);
    expect(await mentionsStored()).toEqual([
      { name: "Ben Analyst", by: "Ana Analyst", at: "2026-01-01T09:00:00.000Z" },
      { name: "Adam Admin", by: "Ana Analyst", at: "2026-01-01T09:01:00.000Z" },
      { name: "Olive Owner", by: "Ana Analyst", at: "2026-01-01T09:01:00.000Z" },
    ]);
  });
});

describe("Only people who can see the Case reach its Discussion", () => {
  test("an Analyst not assigned to a Restricted Case gets not found everywhere", async () => {
    const { ana, ben, restrictedToAna, message, post, edit, retract, list, mentionable } = await acme();
    const number = await restrictedToAna();
    const posted = await message(ana, number, "Restricted talk");
    expect((await list(ben, number)).status).toBe(404);
    expect((await mentionable(ben, number)).status).toBe(404);
    expect((await post(ben, number, "Hello")).status).toBe(404);
    expect((await edit(ben, number, posted.id, "x")).status).toBe(404);
    expect((await retract(ben, number, posted.id)).status).toBe(404);
  });

  test("another Organization's Members get not found", async () => {
    const { t, owner, open, message, list, post } = await acme();
    const number = await open();
    await message(owner, number, "Acme only");
    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    expect((await list(globex, number)).status).toBe(404);
    expect((await post(globex, number, "Hello")).status).toBe(404);
  });
});

describe("Messages and mentions cannot be deleted", () => {
  test("there is no delete route, and the database refuses DELETE and TRUNCATE, and changes to mentions", async () => {
    const { t, ana, ben, mention, open, message } = await acme();
    const number = await open();
    const posted = await message(ana, number, `${await mention(ben)} hi`);
    const route = ana.api.cases[":number"].discussion[":id"] as unknown as {
      $delete: (args: { param: { number: string; id: string } }) => Promise<Response>;
    };
    expect((await route.$delete({ param: { ...param(number), id: posted.id } })).status).toBe(404);
    const db = t.deps.db;
    expect(await dbError(db.execute(sql`DELETE FROM discussion_messages`))).toMatch(/cannot be deleted/);
    expect(await dbError(db.execute(sql`TRUNCATE discussion_messages CASCADE`))).toMatch(/cannot be deleted/);
    expect(await dbError(db.execute(sql`UPDATE discussion_mentions SET user_id = user_id`))).toMatch(/append-only/);
    expect(await dbError(db.execute(sql`DELETE FROM discussion_mentions`))).toMatch(/append-only/);
    expect(await dbError(db.execute(sql`TRUNCATE discussion_mentions`))).toMatch(/append-only/);
  });
});
