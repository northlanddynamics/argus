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

type OccurredAt =
  | { kind: "exact"; at: string }
  | { kind: "range"; start: string; end: string }
  | { kind: "approximate"; at: string; precisionMinutes: number };
type Citation = { kind: "task"; id: string };
type Source = { kind: "discussion_message" | "audit_log_entry"; id: string };
type EntryInput = { occurredAt: OccurredAt; body: string; citations?: Citation[]; source?: Source };

const exact = (at: string): OccurredAt => ({ kind: "exact", at });

/** Acme Security: its Owner, Ana and Ben (Analysts), signed in, and Cases to work. */
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

  const open = async (as: Member = owner) => {
    const res = await as.api.cases.$post({ json: { title: "Suspicious PowerShell", caseType: "malware", severity: "critical" } });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case.number;
  };

  const timeline = (as: Member) => as.api.cases[":number"].timeline;

  const add = async (as: Member, number: number, json: EntryInput) => {
    const res = await timeline(as).$post({ param: param(number), json });
    return { status: res.status, body: await res.json() };
  };
  /** Adds an entry that must succeed, and returns it. */
  const entry = async (as: Member, number: number, json: EntryInput) => {
    const res = await add(as, number, json);
    if (res.status !== 201 || !("entry" in res.body)) throw new Error(`Could not add: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.entry;
  };
  const edit = async (as: Member, number: number, id: string, json: EntryInput & { version: number }) => {
    const { source: _, ...rest } = json;
    const res = await timeline(as)[":id"].$patch({ param: { ...param(number), id }, json: { citations: [], ...rest } });
    return { status: res.status, body: await res.json() };
  };
  const retract = async (as: Member, number: number, id: string, reason: string | null = null) => {
    const res = await timeline(as)[":id"].retract.$post({ param: { ...param(number), id }, json: { reason } });
    return { status: res.status, body: await res.json() };
  };
  const list = async (as: Member, number: number) => {
    const res = await timeline(as).$get({ param: param(number) });
    const body = await res.json();
    return { status: res.status, entries: "entries" in body ? body.entries : null };
  };
  const bodies = async (as: Member, number: number) => (await list(as, number)).entries?.map((e) => e.body);

  const auditLog = async (as: Member, number: number) => {
    const body = await (await as.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };
  const timelineAudit = async (as: Member, number: number) =>
    (await auditLog(as, number))
      .filter((e) => e.action.startsWith("timeline."))
      .map(({ action, actor, target, before, after }) => ({ action, actor: actor.name, target, before, after }));

  const task = async (as: Member, number: number, title: string) => {
    const res = await as.api.cases[":number"].tasks.$post({ param: param(number), json: { title, ownerId: await userId(as) } });
    const body = await res.json();
    if (!("task" in body)) throw new Error(`Could not create a Task: ${res.status}`);
    return body.task;
  };

  const message = async (as: Member, number: number, body: string) => {
    const res = await as.api.cases[":number"].discussion.$post({ param: param(number), json: { body } });
    const json = await res.json();
    if (!("message" in json)) throw new Error(`Could not post: ${res.status}`);
    return json.message;
  };

  return { t, owner, ana, ben, userId, open, add, entry, edit, retract, list, bodies, auditLog, timelineAudit, task, message };
}

describe("Adding Timeline Entries", () => {
  test("occurred-at can be exact, a range or approximate; recorded-at and recorded-by are set automatically", async () => {
    const { t, ana, userId, open, entry, list } = await acme();
    const number = await open();
    t.clock.set(new Date("2026-10-28T11:05:00Z"));
    const approx = await entry(ana, number, {
      occurredAt: { kind: "approximate", at: "2026-10-27T18:00:00Z", precisionMinutes: 360 },
      body: "Phishing email with invoice attachment delivered to d.howe.",
    });
    const range = await entry(ana, number, {
      occurredAt: { kind: "range", start: "2026-10-28T09:20:00Z", end: "2026-10-28T09:47:00Z" },
      body: "Beaconing to 185.220.101.4 roughly every 60 s.",
    });
    const precise = await entry(ana, number, { occurredAt: exact("2026-10-28T09:14:00+00:00"), body: "Attachment opened." });
    const recordedBy = { id: await userId(ana), name: "Ana Analyst" };
    expect(approx).toEqual({
      id: expect.any(String),
      occurredAt: { kind: "approximate", at: "2026-10-27T18:00:00.000Z", precisionMinutes: 360 },
      body: "Phishing email with invoice attachment delivered to d.howe.",
      citations: [],
      source: null,
      version: 1,
      recordedBy,
      recordedAt: "2026-10-28T11:05:00.000Z",
      editedAt: null,
      retracted: null,
    });
    expect(range.occurredAt).toEqual({ kind: "range", start: "2026-10-28T09:20:00.000Z", end: "2026-10-28T09:47:00.000Z" });
    expect(precise.occurredAt).toEqual({ kind: "exact", at: "2026-10-28T09:14:00.000Z" });
    expect((await list(ana, number)).entries?.map((e) => e.id)).toEqual([approx.id, precise.id, range.id]);
  });

  test("the Timeline is ordered by when things happened, not when they were recorded", async () => {
    const { t, ana, ben, open, entry, bodies } = await acme();
    const number = await open();
    await entry(ana, number, { occurredAt: exact("2026-10-28T10:02:00Z"), body: "Host contained." });
    t.clock.advance(60_000);
    await entry(ben, number, {
      occurredAt: { kind: "range", start: "2026-10-28T09:20:00Z", end: "2026-10-28T09:47:00Z" },
      body: "Beaconing.",
    });
    t.clock.advance(60_000);
    await entry(ana, number, { occurredAt: exact("2026-10-28T09:20:00Z"), body: "First beacon." });
    t.clock.advance(60_000);
    await entry(ana, number, { occurredAt: { kind: "approximate", at: "2026-10-27T18:00:00Z", precisionMinutes: 360 }, body: "Email delivered." });
    t.clock.advance(60_000);
    // Same instant, recorded later: after the one recorded first.
    await entry(ben, number, { occurredAt: exact("2026-10-28T10:02:00Z"), body: "Falcon confirms containment." });
    // At the same start, a point in time comes before a range.
    expect(await bodies(ana, number)).toEqual(["Email delivered.", "First beacon.", "Beaconing.", "Host contained.", "Falcon confirms containment."]);
  });

  test("bad occurred-at times and empty text are refused", async () => {
    const { ana, open, add, bodies } = await acme();
    const number = await open();
    const refused = [
      { occurredAt: { kind: "range", start: "2026-10-28T09:47:00Z", end: "2026-10-28T09:20:00Z" }, body: "Backwards" },
      { occurredAt: { kind: "range", start: "2026-10-28T09:20:00Z", end: "2026-10-28T09:20:00Z" }, body: "Empty range" },
      { occurredAt: { kind: "approximate", at: "2026-10-28T09:20:00Z", precisionMinutes: 0 }, body: "No precision" },
      { occurredAt: { kind: "approximate", at: "2026-10-28T09:20:00Z" }, body: "Missing precision" },
      { occurredAt: { kind: "exact", at: "yesterday" }, body: "Not a time" },
      { occurredAt: { kind: "exact", at: "2026-10-28T09:20:00Z" }, body: "   " },
    ] as EntryInput[];
    for (const json of refused) expect((await add(ana, number, json)).status).toBe(400);
    expect(await bodies(ana, number)).toEqual([]);
  });

  test("adding is recorded in the Audit Log with the entry as written", async () => {
    const { ana, open, entry, task, timelineAudit } = await acme();
    const number = await open();
    const contain = await task(ana, number, "Contain host");
    await entry(ana, number, {
      occurredAt: { kind: "approximate", at: "2026-10-27T18:00:00Z", precisionMinutes: 360 },
      body: "Email delivered.",
    });
    await entry(ana, number, {
      occurredAt: { kind: "range", start: "2026-10-28T09:20:00Z", end: "2026-10-28T09:47:00Z" },
      body: "Host network-contained.",
      citations: [{ kind: "task", id: contain.id }],
    });
    expect(await timelineAudit(ana, number)).toEqual([
      {
        action: "timeline.entry_added",
        actor: "Ana Analyst",
        target: null,
        before: null,
        after: "2026-10-28 09:20 → 09:47 UTC · Host network-contained. · cites Task: Contain host",
      },
      { action: "timeline.entry_added", actor: "Ana Analyst", target: null, before: null, after: "≈ 2026-10-27 18:00 UTC ± 6 h · Email delivered." },
    ]);
  });
});

describe("Citations", () => {
  test("entries cite Tasks on the Case, shown with the Task's current title", async () => {
    const { owner, ana, open, entry, list, task } = await acme();
    const number = await open();
    const contain = await task(ana, number, "Contain host");
    const image = await task(ana, number, "Capture memory image");
    const cited = await entry(ana, number, {
      occurredAt: exact("2026-10-28T10:02:00Z"),
      body: "Host network-contained from the Falcon console.",
      citations: [
        { kind: "task", id: contain.id },
        { kind: "task", id: image.id },
        { kind: "task", id: contain.id },
      ],
    });
    expect(cited.citations).toEqual([
      { kind: "task", id: contain.id, label: "Task: Contain host" },
      { kind: "task", id: image.id, label: "Task: Capture memory image" },
    ]);
    await owner.api.cases[":number"].tasks[":id"].$patch({
      param: { ...param(number), id: contain.id },
      json: { title: "Contain FIN-LT-0231", version: contain.version },
    });
    expect((await list(ana, number)).entries?.[0]?.citations[0]?.label).toBe("Task: Contain FIN-LT-0231");
  });

  test("citing a Task on another Case, or nothing at all, is refused and nothing is added", async () => {
    const { ana, open, add, task, bodies, timelineAudit } = await acme();
    const number = await open();
    const other = await open();
    const elsewhere = await task(ana, other, "Elsewhere");
    for (const id of [elsewhere.id, "no-such-task"]) {
      const res = await add(ana, number, { occurredAt: exact("2026-10-28T10:02:00Z"), body: "Contained.", citations: [{ kind: "task", id }] });
      expect(res).toEqual({ status: 400, body: { error: "Entries can only cite items on the same Case" } });
    }
    expect(await bodies(ana, number)).toEqual([]);
    expect(await timelineAudit(ana, number)).toEqual([]);
  });
});

describe("Editing Timeline Entries", () => {
  test("anyone who can see the Case edits an entry; the Audit Log keeps the version before", async () => {
    const { t, ana, ben, open, entry, edit, task, timelineAudit } = await acme();
    const number = await open();
    const contain = await task(ana, number, "Contain host");
    const added = await entry(ana, number, {
      occurredAt: { kind: "approximate", at: "2026-10-28T10:00:00Z", precisionMinutes: 30 },
      body: "contained",
    });
    t.clock.advance(60_000);
    const res = await edit(ben, number, added.id, {
      occurredAt: exact("2026-10-28T10:02:00Z"),
      body: "Host network-contained.",
      citations: [{ kind: "task", id: contain.id }],
      version: 1,
    });
    expect(res.status).toBe(200);
    if (!("entry" in res.body)) throw new Error("No entry");
    expect(res.body.entry).toMatchObject({
      occurredAt: { kind: "exact", at: "2026-10-28T10:02:00.000Z" },
      body: "Host network-contained.",
      citations: [{ kind: "task", id: contain.id, label: "Task: Contain host" }],
      version: 2,
      recordedBy: { name: "Ana Analyst" },
      recordedAt: "2026-01-01T09:00:00.000Z",
      editedAt: "2026-01-01T09:01:00.000Z",
    });
    expect((await timelineAudit(ana, number))[0]).toEqual({
      action: "timeline.entry_edited",
      actor: "Ben Analyst",
      target: null,
      before: "≈ 2026-10-28 10:00 UTC ± 30 min · contained",
      after: "2026-10-28 10:02 UTC · Host network-contained. · cites Task: Contain host",
    });
  });

  test("a save based on an older version is refused with the entry as it is now, and nothing is recorded", async () => {
    const { ana, ben, open, entry, edit, timelineAudit, list } = await acme();
    const number = await open();
    const added = await entry(ana, number, { occurredAt: exact("2026-10-28T10:02:00Z"), body: "Contained." });
    expect((await edit(ben, number, added.id, { occurredAt: exact("2026-10-28T10:02:00Z"), body: "Ben's", version: 1 })).status).toBe(200);
    const stale = await edit(ana, number, added.id, { occurredAt: exact("2026-10-28T10:03:00Z"), body: "Ana's", version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "The Timeline Entry changed since you opened it", current: { body: "Ben's", version: 2 } });
    expect((await list(ana, number)).entries?.[0]?.body).toBe("Ben's");
    expect((await timelineAudit(ana, number)).map((e) => e.action)).toEqual(["timeline.entry_edited", "timeline.entry_added"]);
  });

  test("an edit that changes nothing records nothing and keeps the version", async () => {
    const { ana, open, entry, edit, timelineAudit, task } = await acme();
    const number = await open();
    const contain = await task(ana, number, "Contain host");
    const added = await entry(ana, number, {
      occurredAt: exact("2026-10-28T10:02:00Z"),
      body: "Contained.",
      citations: [{ kind: "task", id: contain.id }],
    });
    const res = await edit(ana, number, added.id, {
      occurredAt: exact("2026-10-28T10:02:00.000+00:00"),
      body: "Contained.",
      citations: [{ kind: "task", id: contain.id }],
      version: 1,
    });
    expect(res.body).toMatchObject({ entry: { version: 1, editedAt: null } });
    expect((await timelineAudit(ana, number)).length).toBe(1);
  });

  test("an entry on another Case is not found", async () => {
    const { ana, open, entry, edit, retract } = await acme();
    const number = await open();
    const other = await open();
    const added = await entry(ana, other, { occurredAt: exact("2026-10-28T10:02:00Z"), body: "Elsewhere." });
    expect((await edit(ana, number, added.id, { occurredAt: exact("2026-10-28T10:02:00Z"), body: "Moved?", version: 1 })).status).toBe(404);
    expect((await retract(ana, number, added.id)).status).toBe(404);
  });
});

describe("Retracting Timeline Entries", () => {
  test("a retracted entry stays on the Timeline, marked with who retracted it and why; the Audit Log keeps it", async () => {
    const { t, ana, ben, userId, open, entry, retract, list, timelineAudit } = await acme();
    const number = await open();
    const added = await entry(ana, number, { occurredAt: exact("2026-10-28T10:15:00Z"), body: "Lateral movement to FIN-LT-0198 observed." });
    t.clock.advance(60_000);
    const res = await retract(ben, number, added.id, "wrong host");
    expect(res.status).toBe(200);
    const [shown] = (await list(ana, number)).entries ?? [];
    expect(shown).toMatchObject({
      body: "Lateral movement to FIN-LT-0198 observed.",
      retracted: { by: { id: await userId(ben), name: "Ben Analyst" }, at: "2026-01-01T09:01:00.000Z", reason: "wrong host" },
    });
    expect((await timelineAudit(ana, number))[0]).toEqual({
      action: "timeline.entry_retracted",
      actor: "Ben Analyst",
      target: null,
      before: "2026-10-28 10:15 UTC · Lateral movement to FIN-LT-0198 observed.",
      after: "wrong host",
    });
  });

  test("a retracted entry can't be edited or retracted again", async () => {
    const { ana, open, entry, edit, retract } = await acme();
    const number = await open();
    const added = await entry(ana, number, { occurredAt: exact("2026-10-28T10:15:00Z"), body: "Wrong." });
    await retract(ana, number, added.id);
    expect(await edit(ana, number, added.id, { occurredAt: exact("2026-10-28T10:15:00Z"), body: "Fixed", version: 1 })).toEqual({
      status: 409,
      body: { error: "This Timeline Entry has been retracted" },
    });
    expect((await retract(ana, number, added.id)).status).toBe(409);
  });
});

describe("Promotion", () => {
  test("a Discussion message is Promoted into an entry that links back to it", async () => {
    const { t, ana, ben, userId, open, entry, message, list, timelineAudit } = await acme();
    const number = await open();
    const posted = await message(ben, number, "Containing host from console now.");
    t.clock.advance(60_000);
    const promoted = await entry(ana, number, {
      occurredAt: exact(posted.postedAt),
      body: "Ben began containing the host from the console.",
      source: { kind: "discussion_message", id: posted.id },
    });
    expect(promoted.source).toEqual({
      kind: "discussion_message",
      id: posted.id,
      author: { id: await userId(ben), name: "Ben Analyst" },
      postedAt: posted.postedAt,
    });
    expect((await list(ana, number)).entries?.[0]?.source?.id).toBe(posted.id);
    expect((await timelineAudit(ana, number))[0]).toEqual({
      action: "timeline.entry_promoted",
      actor: "Ana Analyst",
      target: "from Discussion message",
      before: null,
      after: "2026-01-01 09:00 UTC · Ben began containing the host from the console.",
    });
  });

  test("a Case Audit Log entry is Promoted into an entry that links back to it", async () => {
    const { owner, ana, open, entry, auditLog } = await acme();
    const number = await open();
    await owner.api.cases[":number"].$patch({ param: param(number), json: { severity: "high" } });
    const changed = (await auditLog(ana, number)).find((e) => e.action === "case.severity_changed")!;
    const promoted = await entry(ana, number, {
      occurredAt: exact(changed.occurredAt),
      body: "Severity lowered to High after triage.",
      source: { kind: "audit_log_entry", id: changed.id },
    });
    expect(promoted.source).toEqual({
      kind: "audit_log_entry",
      id: changed.id,
      action: "case.severity_changed",
      actor: "Olive Owner",
      occurredAt: changed.occurredAt,
    });
  });

  test("a source is on the Timeline once; retracting that entry lets it be Promoted again", async () => {
    const { ana, ben, open, entry, add, message, retract } = await acme();
    const number = await open();
    const posted = await message(ben, number, "Contained.");
    const source = { kind: "discussion_message", id: posted.id } as const;
    const first = await entry(ana, number, { occurredAt: exact(posted.postedAt), body: "Contained.", source });
    const again = await add(ben, number, { occurredAt: exact(posted.postedAt), body: "Contained!", source });
    expect(again as unknown).toEqual({ status: 409, body: { error: "This is already on the Timeline", entryId: first.id } });
    await retract(ana, number, first.id);
    expect((await add(ben, number, { occurredAt: exact(posted.postedAt), body: "Contained!", source })).status).toBe(201);
  });

  test("a retracted message, or a source on another Case, can't be Promoted", async () => {
    const { ana, open, add, message, auditLog, bodies } = await acme();
    const number = await open();
    const other = await open();
    const retracted = await message(ana, number, "Oops");
    await ana.api.cases[":number"].discussion[":id"].retract.$post({ param: { ...param(number), id: retracted.id } });
    const elsewhere = await message(ana, other, "Elsewhere");
    const otherAudit = (await auditLog(ana, other))[0]!;
    const at = exact("2026-10-28T10:00:00Z");
    expect(await add(ana, number, { occurredAt: at, body: "x", source: { kind: "discussion_message", id: retracted.id } })).toEqual({
      status: 409,
      body: { error: "A retracted message can't be Promoted" },
    });
    for (const source of [
      { kind: "discussion_message", id: elsewhere.id },
      { kind: "audit_log_entry", id: otherAudit.id },
      { kind: "audit_log_entry", id: "nothing" },
    ] as const) {
      expect(await add(ana, number, { occurredAt: at, body: "x", source })).toEqual({
        status: 400,
        body: { error: "Nothing to Promote: the source isn't on this Case" },
      });
    }
    expect(await bodies(ana, number)).toEqual([]);
  });
});

describe("A Closed Case's Timeline is read-only", () => {
  test("adding, editing, retracting and Promoting are refused until an Admin reopens it", async () => {
    const { owner, ana, open, add, entry, edit, retract, message, bodies } = await acme();
    const number = await open();
    const added = await entry(ana, number, { occurredAt: exact("2026-10-28T10:00:00Z"), body: "Before closing." });
    const posted = await message(ana, number, "Contained.");
    await owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "true_positive" } });
    const at = exact("2026-10-28T10:00:00Z");
    expect((await add(ana, number, { occurredAt: at, body: "After" })).status).toBe(409);
    expect((await add(ana, number, { occurredAt: at, body: "After", source: { kind: "discussion_message", id: posted.id } })).status).toBe(409);
    expect((await edit(ana, number, added.id, { occurredAt: at, body: "After", version: 1 })).status).toBe(409);
    expect((await retract(ana, number, added.id)).status).toBe(409);
    expect(await bodies(ana, number)).toEqual(["Before closing."]);
    await owner.api.cases[":number"].reopen.$post({ param: param(number) });
    expect((await add(ana, number, { occurredAt: at, body: "After" })).status).toBe(201);
  });
});

describe("Only people who can see the Case reach its Timeline", () => {
  test("an Analyst not assigned to a Restricted Case gets not found everywhere", async () => {
    const { owner, ana, ben, userId, open, add, entry, edit, retract, list } = await acme();
    const number = await open();
    await owner.api.cases[":number"].$patch({ param: param(number), json: { assigneeId: await userId(ana), restricted: true } });
    const added = await entry(ana, number, { occurredAt: exact("2026-10-28T10:00:00Z"), body: "Secret." });
    const at = exact("2026-10-28T10:00:00Z");
    expect((await list(ben, number)).status).toBe(404);
    expect((await add(ben, number, { occurredAt: at, body: "x" })).status).toBe(404);
    expect((await edit(ben, number, added.id, { occurredAt: at, body: "x", version: 1 })).status).toBe(404);
    expect((await retract(ben, number, added.id)).status).toBe(404);
    expect((await list(owner, number)).entries?.length).toBe(1);
  });

  test("a change to the Timeline signals the Case live", async () => {
    const { t, ana, ben, open, entry } = await acme();
    const number = await open();
    const socket = await t.connect(ben);
    await entry(ana, number, { occurredAt: exact("2026-10-28T10:00:00Z"), body: "Contained." });
    await socket.next((m) => m.type === "case" && m.number === number);
  });
});

describe("Timeline Entries cannot be deleted", () => {
  test("there is no delete route, and the database refuses DELETE and TRUNCATE", async () => {
    const { t, ana, open, entry } = await acme();
    const number = await open();
    const added = await entry(ana, number, { occurredAt: exact("2026-10-28T10:00:00Z"), body: "Kept." });
    const route = ana.api.cases[":number"].timeline[":id"] as unknown as {
      $delete: (args: { param: { number: string; id: string } }) => Promise<Response>;
    };
    expect((await route.$delete({ param: { ...param(number), id: added.id } })).status).toBe(404);
    const db = t.deps.db;
    expect(await dbError(db.execute(sql`DELETE FROM timeline_entries`))).toMatch(/cannot be deleted/);
    expect(await dbError(db.execute(sql`TRUNCATE timeline_entries CASCADE`))).toMatch(/cannot be deleted/);
  });
});
