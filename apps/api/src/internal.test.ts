import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import type { InternalItemKind } from "./internal/vocabulary";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const COUNSEL = "k.patel@lawfirm.example";
const param = (number: number) => ({ number: String(number) });
const at = (iso: string) => ({ kind: "exact" as const, at: iso });
/** The ids of the items listed under `key`. */
const ids = (body: Record<string, unknown>, key: string) => (body[key] as { id: string }[] | undefined)?.map((x) => x.id) ?? [];

/**
 * Acme Security: the Owner and Ana (an Analyst) signed in, a CrowdStrike Integration feeding Alerts,
 * and one Case with outside counsel (Kim Patel) on it as a Guest, signed in.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Session = ReturnType<typeof t.session>;

  const userId = async (as: Session) => {
    const me = await (await as.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  };

  const opened = await (await owner.api.cases.$post({ json: { title: "Suspicious PowerShell on FIN-LT-0231", caseType: "malware", severity: "high" } })).json();
  if (!("case" in opened)) throw new Error("Could not open a Case");
  const number = opened.case.number;
  const invited = await owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel" } });
  if (invited.status !== 201) throw new Error(`Could not invite counsel: ${invited.status}`);
  const guest = await t.guestSignIn(COUNSEL);
  const guestId = await userId(guest);

  await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret" } });
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const stream = falcon.tenant(CLIENT_ID);
  let detections = 0;

  /** The Alert queue's view of Alert `id`, with its version. */
  const queued = async (id: string) => {
    const body = await (await owner.api.alerts.$get({ query: {} })).json();
    if (!("alerts" in body)) throw new Error("No Alert queue");
    return body.alerts.find((a) => a.id === id)!;
  };
  /** Attaches the Alert to Case `to`, as the Owner. */
  const attach = async (id: string, to: number) => {
    const res = await owner.api.alerts.attach.$post({ json: { case: to, alerts: [{ id, version: (await queued(id)).version }] } });
    if (res.status !== 200) throw new Error(`Could not attach: ${res.status}`);
  };
  /** A new Alert from Falcon, attached to the Case. */
  const newAlert = async () => {
    const compositeId = `ldt:acme:${++detections}`;
    stream.detection("EppDetectionSummaryEvent", compositeId, { Name: `Detection ${detections}`, SeverityName: "High", Hostname: "FIN-LT-0231" });
    await stream.drained();
    const body = await (await owner.api.alerts.$get({ query: {} })).json();
    if (!("alerts" in body)) throw new Error("No Alert queue");
    const { id } = body.alerts.find((a) => a.externalId === compositeId)!;
    await attach(id, number);
    return id;
  };

  /** Adds Evidence as `as`, optionally Internal; returns the response. */
  const upload = (as: Session, name: string, internal?: boolean) =>
    t.app.request(`http://argus.test/api/cases/${number}/evidence?name=${name}${internal === undefined ? "" : `&internal=${internal}`}`, {
      method: "POST",
      headers: { cookie: as.cookieHeader(), origin: "http://argus.test", "content-type": "text/plain" },
      body: `Contents of ${name}`,
    });

  const mark = async (as: Session, kind: InternalItemKind, id: string, internal: boolean, on = number) => {
    const res = await as.api.cases[":number"].internal.$put({ param: param(on), json: { item: { kind, id }, internal } });
    return { status: res.status, body: await res.json() };
  };

  const auditLog = async () => {
    const body = await (await owner.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };

  type Kind = {
    /** Adds one as a Member; Internal or not. Returns its id. */
    add: (internal: boolean) => Promise<string>;
    /** The ids of those `as` sees on the Case. */
    seen: (as: Session) => Promise<string[]>;
    /** Changes it as a Member, in a way that would signal the Case. */
    change: (id: string) => Promise<unknown>;
  };
  let n = 0;

  /** Every kind of item that can be Internal: how to add, read and change one. */
  const kinds: Record<InternalItemKind, Kind> = {
    task: {
      add: async (internal) => {
        const res = await owner.api.cases[":number"].tasks.$post({
          param: param(number),
          json: { title: `Task ${++n}`, ownerId: await userId(ana), internal },
        });
        return ((await res.json()) as { task: { id: string } }).task.id;
      },
      seen: async (as) => ids(await (await as.api.cases[":number"].tasks.$get({ param: param(number) })).json(), "tasks"),
      change: (id) => owner.api.cases[":number"].tasks[":id"].done.$put({ param: { ...param(number), id }, json: { done: true } }),
    },
    discussion_message: {
      add: async (internal) => {
        const res = await owner.api.cases[":number"].discussion.$post({ param: param(number), json: { body: `Message ${++n}`, internal } });
        return ((await res.json()) as { message: { id: string } }).message.id;
      },
      seen: async (as) => ids(await (await as.api.cases[":number"].discussion.$get({ param: param(number) })).json(), "messages"),
      change: (id) => owner.api.cases[":number"].discussion[":id"].$patch({ param: { ...param(number), id }, json: { body: "Edited." } }),
    },
    timeline_entry: {
      add: async (internal) => {
        const res = await owner.api.cases[":number"].timeline.$post({
          param: param(number),
          json: { occurredAt: at("2026-10-28T09:14:00Z"), body: `Entry ${++n}`, internal },
        });
        return ((await res.json()) as { entry: { id: string } }).entry.id;
      },
      seen: async (as) => ids(await (await as.api.cases[":number"].timeline.$get({ param: param(number) })).json(), "entries"),
      change: (id) =>
        owner.api.cases[":number"].timeline[":id"].retract.$post({ param: { ...param(number), id }, json: { reason: null } }),
    },
    evidence: {
      add: async (internal) => ((await (await upload(owner, `file-${++n}.txt`, internal)).json()) as { evidence: { id: string } }).evidence.id,
      seen: async (as) => ids(await (await as.api.cases[":number"].evidence.$get({ param: param(number) })).json(), "evidence"),
      change: (id) => owner.api.cases[":number"].evidence[":id"].view.$get({ param: { ...param(number), id } }),
    },
    alert: {
      add: async (internal) => {
        const id = await newAlert();
        if (!internal) await mark(owner, "alert", id, false);
        return id;
      },
      seen: async (as) => ids(await (await as.api.cases[":number"].alerts.$get({ param: param(number) })).json(), "alerts"),
      change: async (id) => owner.api.alerts[":id"].detach.$post({ param: { id }, json: { version: (await queued(id)).version } }),
    },
  };

  return { t, owner, ana, guest, guestId, userId, number, kinds, mark, upload, auditLog, attach, newAlert, queued };
}

const KINDS: InternalItemKind[] = ["task", "discussion_message", "timeline_entry", "evidence", "alert"];
const LABELS: Record<InternalItemKind, RegExp> = {
  task: /^Task: Task \d+$/,
  discussion_message: /^Message from Olive Owner$/,
  timeline_entry: /^Timeline Entry: Entry \d+$/,
  evidence: /^Evidence: file-\d+\.txt$/,
  alert: /^Alert: Detection \d+ \(ldt:acme:\d+\)$/,
};

describe("Guests × Internal, for every kind of item", () => {
  test.each(KINDS)("a Guest sees a %s only while it isn't Internal; Members see both", async (kind) => {
    const a = await acme();
    const visible = await a.kinds[kind].add(false);
    const hidden = await a.kinds[kind].add(true);
    expect(await a.kinds[kind].seen(a.ana)).toEqual(expect.arrayContaining([visible, hidden]));
    expect(await a.kinds[kind].seen(a.guest)).toEqual([visible]);
  });

  test.each(KINDS)("marking a %s Internal hides it from the Guest and back again, each recorded in the Audit Log", async (kind) => {
    const a = await acme();
    const id = await a.kinds[kind].add(false);
    expect(await a.kinds[kind].seen(a.guest)).toEqual([id]);

    expect(await a.mark(a.ana, kind, id, true)).toEqual({ status: 200, body: { internal: true } });
    expect(await a.kinds[kind].seen(a.guest)).toEqual([]);
    expect(await a.kinds[kind].seen(a.ana)).toEqual([id]);
    const [marked] = await a.auditLog();
    expect(marked).toMatchObject({ actor: { type: "member", name: "Ana Analyst" }, action: "item.marked_internal" });
    expect(marked!.target).toMatch(LABELS[kind]);

    // Marking it what it already is changes nothing.
    await a.mark(a.ana, kind, id, true);
    expect((await a.auditLog())[0]!.id).toBe(marked!.id);

    expect(await a.mark(a.owner, kind, id, false)).toEqual({ status: 200, body: { internal: false } });
    expect(await a.kinds[kind].seen(a.guest)).toEqual([id]);
    expect((await a.auditLog())[0]).toMatchObject({ actor: { name: "Olive Owner" }, action: "item.shown_to_guests", target: marked!.target });
  });

  test.each(KINDS)("a Guest can't mark a %s Internal, and items elsewhere aren't found", async (kind) => {
    const a = await acme();
    const id = await a.kinds[kind].add(false);
    expect((await a.mark(a.guest, kind, id, true)).status).toBe(403);
    expect(await a.kinds[kind].seen(a.guest)).toEqual([id]);
    expect(await a.mark(a.owner, kind, "no-such-item", true)).toEqual({ status: 404, body: { error: "Nothing like that on this Case" } });
    const other = await (await a.owner.api.cases.$post({ json: { title: "Another", caseType: "other", severity: "low" } })).json();
    if (!("case" in other)) throw new Error("No Case");
    expect((await a.mark(a.owner, kind, id, true, other.case.number)).status).toBe(404);
  });

  test.each(KINDS)("changes to an Internal %s never reach the Guest's live socket", async (kind) => {
    const a = await acme();
    const hidden = await a.kinds[kind].add(true);
    const live = await a.t.connect(a.guest);
    const memberLive = await a.t.connect(a.ana);

    await a.kinds[kind].change(hidden);
    await memberLive.next((m) => m.type === "case");
    // Then something the Guest does see.
    await a.owner.api.cases[":number"].$patch({ param: param(a.number), json: { severity: "critical" } });
    await live.next((m) => m.type === "case");
    await a.t.live.settled();
    expect(live.messages.filter((m) => m.type === "case")).toEqual([{ type: "case", number: a.number }]);
  });

  test.each(KINDS)("marking a %s Internal, or showing it again, reaches the Guest's live socket", async (kind) => {
    const a = await acme();
    const id = await a.kinds[kind].add(false);
    const live = await a.t.connect(a.guest);
    await a.mark(a.owner, kind, id, true);
    expect(await live.next((m) => m.type === "case")).toEqual({ type: "case", number: a.number });
    await a.mark(a.owner, kind, id, false);
    expect(await live.next((m) => m.type === "case")).toEqual({ type: "case", number: a.number });
  });

  test.each(KINDS)("a %s can't be marked Internal on a Closed Case", async (kind) => {
    const a = await acme();
    const id = await a.kinds[kind].add(false);
    await a.owner.api.cases[":number"].close.$post({ param: param(a.number), json: { resolution: "true_positive" } });
    expect((await a.mark(a.owner, kind, id, true)).status).toBe(409);
  });
});

describe("Internal items in detail", () => {
  test("attaching an Alert makes it Internal, even one that was shown to Guests on another Case", async () => {
    const a = await acme();
    const id = await a.newAlert();
    expect((await a.queued(id)).internal).toBe(true);
    const detail = await (await a.owner.api.alerts[":id"].$get({ param: { id } })).json();
    expect(detail).toMatchObject({ alert: { internal: true } });
    await a.mark(a.owner, "alert", id, false);
    expect(await a.kinds.alert.seen(a.guest)).toEqual([id]);

    const other = await (await a.owner.api.cases.$post({ json: { title: "Another", caseType: "other", severity: "low" } })).json();
    if (!("case" in other)) throw new Error("No Case");
    const live = await a.t.connect(a.guest);
    await a.attach(id, other.case.number);
    // The Guest hears that it left their Case.
    expect(await live.next((m) => m.type === "case")).toEqual({ type: "case", number: a.number });
    expect(await a.kinds.alert.seen(a.guest)).toEqual([]);
    await a.attach(id, a.number);
    expect((await a.queued(id)).internal).toBe(true);
    expect(await a.kinds.alert.seen(a.guest)).toEqual([]);
  });

  test("a Guest's Case view counts only the Tasks they can see", async () => {
    const a = await acme();
    await a.kinds.task.add(false);
    await a.kinds.task.add(true);
    const asGuest = await (await a.guest.api.cases[":number"].$get({ param: param(a.number) })).json();
    const asMember = await (await a.ana.api.cases[":number"].$get({ param: param(a.number) })).json();
    expect(asGuest).toMatchObject({ case: { tasks: { total: 1, done: 0 } } });
    expect(asMember).toMatchObject({ case: { tasks: { total: 2, done: 0 } } });
  });

  test("a Guest can't open Internal Evidence", async () => {
    const a = await acme();
    const id = await a.kinds.evidence.add(true);
    for (const access of ["view", "download"] as const) {
      const res = await a.guest.api.cases[":number"].evidence[":id"][access].$get({ param: { ...param(a.number), id } });
      expect(res.status).toBe(404);
    }
    const entries = await a.auditLog();
    expect(entries.some((e) => e.action === "evidence.viewed" || e.action === "evidence.downloaded")).toBe(false);
  });

  test("a Guest doesn't see which Internal Tasks an entry cites, nor an Internal message it was Promoted from", async () => {
    const a = await acme();
    const shown = await a.kinds.task.add(false);
    const hidden = await a.kinds.task.add(true);
    const cited = await (
      await a.owner.api.cases[":number"].timeline.$post({
        param: param(a.number),
        json: { occurredAt: at("2026-10-28T09:14:00Z"), body: "Host contained.", citations: [{ kind: "task", id: shown }, { kind: "task", id: hidden }] },
      })
    ).json();
    if (!("entry" in cited)) throw new Error("No entry");
    expect(cited.entry.citations.map((c) => c.id)).toEqual([shown, hidden]);
    const forGuest = await (await a.guest.api.cases[":number"].timeline.$get({ param: param(a.number) })).json();
    expect(forGuest).toMatchObject({ entries: [{ id: cited.entry.id, citations: [{ id: shown, label: "Task: Task 1" }] }] });
    expect("entries" in forGuest && forGuest.entries[0]!.citations).toHaveLength(1);

    // Promoting an Internal message makes an Internal entry, unless the Member says otherwise.
    const message = await a.kinds.discussion_message.add(true);
    const promoted = await (
      await a.owner.api.cases[":number"].timeline.$post({
        param: param(a.number),
        json: { occurredAt: at("2026-10-28T10:00:00Z"), body: "From the Discussion.", source: { kind: "discussion_message", id: message } },
      })
    ).json();
    expect(promoted).toMatchObject({ entry: { internal: true, source: { kind: "discussion_message", id: message } } });
    await a.mark(a.owner, "timeline_entry", "entry" in promoted ? promoted.entry.id : "", false);
    const shownToGuest = await (await a.guest.api.cases[":number"].timeline.$get({ param: param(a.number) })).json();
    if (!("entries" in shownToGuest)) throw new Error("No Timeline");
    expect(shownToGuest.entries.find((e) => e.body === "From the Discussion.")?.source).toBeNull();
  });

  test("Evidence stays unalterable apart from its Internal marking", async () => {
    const a = await acme();
    await a.kinds.evidence.add(false);
    const db = a.t.deps.db;
    await db.execute(sql`UPDATE evidence SET internal = true`);
    const error = await db.execute(sql`UPDATE evidence SET internal = false, name = 'other.txt'`).then(
      () => null,
      (e: { cause?: unknown }) => String(e.cause ?? e),
    );
    expect(error).toMatch(/cannot be altered or deleted/);
  });
});

describe("Guests take part in what they can see", () => {
  test("a Guest posts, edits and retracts their own messages, but can't post an Internal one", async () => {
    const a = await acme();
    const res = await a.guest.api.cases[":number"].discussion.$post({ param: param(a.number), json: { body: "Was customer data on the laptop?" } });
    expect(res.status).toBe(201);
    const posted = await res.json();
    if (!("message" in posted)) throw new Error("No message");
    expect(posted.message).toMatchObject({ author: { id: a.guestId, name: "Kim Patel" }, internal: false, can: { edit: true, retract: true } });
    expect(await a.kinds.discussion_message.seen(a.ana)).toEqual([posted.message.id]);
    expect((await a.auditLog())[0]).toMatchObject({ actor: { type: "guest", name: "Kim Patel" }, action: "discussion.message_posted" });

    const edited = await a.guest.api.cases[":number"].discussion[":id"].$patch({
      param: { ...param(a.number), id: posted.message.id },
      json: { body: "Was customer data on FIN-LT-0231?" },
    });
    expect(edited.status).toBe(200);
    const retracted = await a.guest.api.cases[":number"].discussion[":id"].retract.$post({ param: { ...param(a.number), id: posted.message.id } });
    expect(retracted.status).toBe(200);

    const internal = await a.guest.api.cases[":number"].discussion.$post({ param: param(a.number), json: { body: "Secret", internal: true } });
    expect(internal.status).toBe(403);
    // Nor edit one they can't see.
    const hidden = await a.kinds.discussion_message.add(true);
    const refused = await a.guest.api.cases[":number"].discussion[":id"].$patch({ param: { ...param(a.number), id: hidden }, json: { body: "Mine now" } });
    expect(refused.status).toBe(404);
  });

  test("a Guest may mention, and be mentioned by, people who can see the Case", async () => {
    const a = await acme();
    const people = await (await a.guest.api.cases[":number"].discussion.mentionable.$get({ param: param(a.number) })).json();
    expect(people).toEqual({
      people: [
        { id: await a.userId(a.ana), name: "Ana Analyst", role: "analyst" },
        { id: await a.userId(a.owner), name: "Olive Owner", role: "owner" },
        { id: a.guestId, name: "Kim Patel", role: "guest" },
      ],
    });
    const fromGuest = await a.guest.api.cases[":number"].discussion.$post({
      param: param(a.number),
      json: { body: `<@${await a.userId(a.ana)}> can you confirm?` },
    });
    expect(fromGuest.status).toBe(201);
    const toGuest = await a.owner.api.cases[":number"].discussion.$post({ param: param(a.number), json: { body: `<@${a.guestId}> yes, payroll data.` } });
    expect(toGuest.status).toBe(201);
  });

  test("a Guest owns and completes Tasks they can see, but not Internal ones", async () => {
    const a = await acme();
    const created = await a.owner.api.cases[":number"].tasks.$post({
      param: param(a.number),
      json: { title: "Assess notification duty", ownerId: a.guestId, dueDate: "2026-11-04" },
    });
    expect(created.status).toBe(201);
    const { task } = (await created.json()) as { task: { id: string; owner: { name: string } } };
    expect(task.owner.name).toBe("Kim Patel");

    const done = await a.guest.api.cases[":number"].tasks[":id"].done.$put({ param: { ...param(a.number), id: task.id }, json: { done: true } });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ task: { done: true, completed: { by: { id: a.guestId, name: "Kim Patel" } } } });
    expect((await a.auditLog())[0]).toMatchObject({ actor: { type: "guest" }, action: "task.completed", target: "Assess notification duty" });

    const hidden = await a.kinds.task.add(true);
    const refused = await a.guest.api.cases[":number"].tasks[":id"].done.$put({ param: { ...param(a.number), id: hidden }, json: { done: true } });
    expect(refused.status).toBe(404);
  });

  test("a Guest adds Evidence, but not as Internal", async () => {
    const a = await acme();
    const added = await a.upload(a.guest, "counsel-memo.txt");
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ evidence: { name: "counsel-memo.txt", addedBy: { id: a.guestId }, internal: false } });
    expect((await a.auditLog())[0]).toMatchObject({ actor: { type: "guest", name: "Kim Patel" }, action: "evidence.added" });
    expect((await a.upload(a.guest, "secret.txt", true)).status).toBe(403);
    expect(await a.kinds.evidence.seen(a.ana)).toHaveLength(1);
  });

  test("Guests still can't create Tasks, write the Timeline or mark anything", async () => {
    const a = await acme();
    const task = await a.guest.api.cases[":number"].tasks.$post({ param: param(a.number), json: { title: "Mine", ownerId: a.guestId } });
    expect(task.status as number).toBe(403);
    const entry = await a.guest.api.cases[":number"].timeline.$post({ param: param(a.number), json: { occurredAt: at("2026-10-28T09:14:00Z"), body: "Mine" } });
    expect(entry.status as number).toBe(403);
  });
});

describe("Internal items never involve Guests", () => {
  const REFUSED = { error: "Guests can't see Internal items, so an Internal item can't mention a Guest or be owned by one" };

  test("an Internal message can't mention a Guest, by posting or editing", async () => {
    const a = await acme();
    const post = await a.owner.api.cases[":number"].discussion.$post({ param: param(a.number), json: { body: `<@${a.guestId}> see this`, internal: true } });
    expect({ status: post.status, body: await post.json() }).toEqual({ status: 400, body: REFUSED });
    const id = await a.kinds.discussion_message.add(true);
    const edit = await a.owner.api.cases[":number"].discussion[":id"].$patch({ param: { ...param(a.number), id }, json: { body: `<@${a.guestId}> see this` } });
    expect({ status: edit.status, body: await edit.json() }).toEqual({ status: 400, body: REFUSED });
  });

  test("a message that mentions a Guest can't be marked Internal", async () => {
    const a = await acme();
    const res = await a.owner.api.cases[":number"].discussion.$post({ param: param(a.number), json: { body: `<@${a.guestId}> please review` } });
    const { message } = (await res.json()) as { message: { id: string } };
    expect(await a.mark(a.owner, "discussion_message", message.id, true)).toEqual({ status: 400, body: REFUSED });
    expect(await a.kinds.discussion_message.seen(a.guest)).toEqual([message.id]);
  });

  test("a Guest can't own an Internal Task, however it would come about", async () => {
    const a = await acme();
    const create = await a.owner.api.cases[":number"].tasks.$post({
      param: param(a.number),
      json: { title: "Hidden", ownerId: a.guestId, internal: true },
    });
    expect({ status: create.status, body: await create.json() }).toEqual({ status: 400, body: REFUSED });

    const hidden = await a.kinds.task.add(true);
    const tasks = await (await a.owner.api.cases[":number"].tasks.$get({ param: param(a.number) })).json();
    const version = "tasks" in tasks ? tasks.tasks.find((t) => t.id === hidden)!.version : 0;
    const reassign = await a.owner.api.cases[":number"].tasks[":id"].$patch({ param: { ...param(a.number), id: hidden }, json: { ownerId: a.guestId, version } });
    expect({ status: reassign.status, body: await reassign.json() }).toEqual({ status: 400, body: REFUSED });

    const theirs = await (
      await a.owner.api.cases[":number"].tasks.$post({ param: param(a.number), json: { title: "Theirs", ownerId: a.guestId } })
    ).json();
    if (!("task" in theirs)) throw new Error("No Task");
    expect(await a.mark(a.owner, "task", theirs.task.id, true)).toEqual({ status: 400, body: REFUSED });
  });
});
