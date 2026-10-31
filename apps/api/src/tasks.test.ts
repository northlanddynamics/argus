import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const DAY = 24 * 60 * 60 * 1000;
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

/** Acme Security: its Owner, Ana and Ben (Analysts), signed in, and a Case to work. */
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

  type NewTask = Parameters<Member["api"]["cases"][":number"]["tasks"]["$post"]>[0]["json"];
  const create = async (as: Member, number: number, json: Partial<NewTask> = {}) => {
    const res = await as.api.cases[":number"].tasks.$post({
      param: param(number),
      json: { title: "Contain host", ownerId: await userId(ana), ...json },
    });
    return { status: res.status, body: await res.json() };
  };
  /** Creates a Task that must succeed, and returns it. */
  const task = async (as: Member, number: number, json: Partial<NewTask> = {}) => {
    const { status, body } = await create(as, number, json);
    if (status !== 201 || !("task" in body)) throw new Error(`Could not create a Task: ${status} ${JSON.stringify(body)}`);
    return body.task;
  };

  type Edit = Parameters<Member["api"]["cases"][":number"]["tasks"][":id"]["$patch"]>[0]["json"];
  const edit = async (as: Member, number: number, id: string, json: Edit) => {
    const res = await as.api.cases[":number"].tasks[":id"].$patch({ param: { ...param(number), id }, json });
    return { status: res.status, body: await res.json() };
  };

  const setDone = async (as: Member, number: number, id: string, done: boolean) => {
    const res = await as.api.cases[":number"].tasks[":id"].done.$put({ param: { ...param(number), id }, json: { done } });
    return { status: res.status, body: await res.json() };
  };

  const list = async (as: Member, number: number) => {
    const res = await as.api.cases[":number"].tasks.$get({ param: param(number) });
    return { status: res.status, body: await res.json() };
  };

  const auditLog = async (as: Member, number: number) => {
    const body = await (await as.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };

  const change = (as: Member, number: number, json: { assigneeId?: string | null; restricted?: boolean }) =>
    as.api.cases[":number"].$patch({ param: param(number), json });

  return { t, owner, ana, ben, userId, open, create, task, edit, setDone, list, auditLog, change };
}

describe("Creating Tasks", () => {
  test("a Member creates a Task with a title, description, owner and due date; it starts not done", async () => {
    const { ben, ana, userId, open, task, list } = await acme();
    const number = await open();
    const created = await task(ben, number, {
      title: "Contain host",
      description: "Network-contain FIN-LT-0231 from Falcon",
      ownerId: await userId(ana),
      dueDate: "2026-01-05",
    });
    expect(created).toMatchObject({
      title: "Contain host",
      description: "Network-contain FIN-LT-0231 from Falcon",
      owner: { id: await userId(ana), name: "Ana Analyst" },
      dueDate: "2026-01-05",
      overdue: false,
      done: false,
      completed: null,
      version: 1,
      createdBy: { id: await userId(ben), name: "Ben Analyst" },
    });
    const { status, body } = await list(ana, number);
    expect(status).toBe(200);
    expect(body).toEqual({ tasks: [created] });
  });

  test("the due date and description are optional; Tasks list oldest first", async () => {
    const { t, owner, open, task, list } = await acme();
    const number = await open();
    const first = await task(owner, number, { title: "Capture memory image" });
    t.clock.advance(1000);
    const second = await task(owner, number, { title: "Block C2 IP at egress" });
    expect(first).toMatchObject({ description: "", dueDate: null });
    const { body } = await list(owner, number);
    expect("tasks" in body && body.tasks.map((x) => x.id)).toEqual([first.id, second.id]);
  });

  test("a title and a real date are required", async () => {
    const { owner, open, create } = await acme();
    const number = await open();
    expect((await create(owner, number, { title: "  " })).status).toBe(400);
    expect((await create(owner, number, { dueDate: "2026-02-30" })).status).toBe(400);
    expect((await create(owner, number, { dueDate: "next week" })).status).toBe(400);
  });

  test("creating is recorded in the Audit Log with the Task's title and owner", async () => {
    const { t, ben, userId, open, task, auditLog } = await acme();
    const number = await open();
    await task(ben, number, { title: "Reset d.howe credentials" });
    expect((await auditLog(ben, number))[0]).toEqual({
      id: expect.any(String),
      occurredAt: t.clock.now().toISOString(),
      actor: { type: "member", id: await userId(ben), name: "Ben Analyst" },
      action: "task.created",
      target: "Reset d.howe credentials",
      before: null,
      after: "Ana Analyst",
    });
  });

  test("the Case shows how many of its Tasks are done", async () => {
    const { owner, open, task, setDone } = await acme();
    const number = await open();
    const a = await task(owner, number);
    await task(owner, number);
    await setDone(owner, number, a.id, true);
    const body = await (await owner.api.cases[":number"].$get({ param: param(number) })).json();
    expect("case" in body && body.case.tasks).toEqual({ done: 1, total: 2 });
  });
});

describe("A Task's owner must be someone who can see the Case", () => {
  test("someone outside the Organization can't own a Task", async () => {
    const { t, owner, open, create, userId } = await acme();
    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    const number = await open();
    const { status, body } = await create(owner, number, { ownerId: await userId(globex) });
    expect(status).toBe(400);
    expect(body).toEqual({ error: "A Task's owner must be someone who can see the Case" });
    expect((await create(owner, number, { ownerId: "nobody" })).status).toBe(400);
  });

  test("on a Restricted Case, an Analyst not assigned to it can't own a Task; its Assignee and Admins can", async () => {
    const { owner, ana, ben, open, create, change, userId } = await acme();
    const number = await open();
    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    expect((await create(owner, number, { ownerId: await userId(ben) })).status).toBe(400);
    expect((await create(owner, number, { ownerId: await userId(ana) })).status).toBe(201);
    expect((await create(ana, number, { ownerId: await userId(owner) })).status).toBe(201);
  });

  test("handing a Task to someone who can't see the Case is refused, and nothing changes", async () => {
    const { owner, ana, ben, open, task, edit, change, userId, auditLog } = await acme();
    const number = await open();
    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    const created = await task(owner, number);
    const before = await auditLog(owner, number);
    const { status } = await edit(owner, number, created.id, { ownerId: await userId(ben), version: 1 });
    expect(status).toBe(400);
    expect(await auditLog(owner, number)).toEqual(before);
  });
});

describe("Editing Tasks", () => {
  test("an edit with the current version changes the fields, moves the version on and records each change", async () => {
    const { ben, owner, userId, open, task, edit, auditLog } = await acme();
    const number = await open();
    const created = await task(owner, number, { title: "Contain host", dueDate: "2026-01-05" });
    const { status, body } = await edit(ben, number, created.id, {
      title: "Contain FIN-LT-0231",
      description: "From the Falcon console",
      ownerId: await userId(ben),
      dueDate: null,
      version: 1,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      task: {
        title: "Contain FIN-LT-0231",
        description: "From the Falcon console",
        owner: { id: await userId(ben), name: "Ben Analyst" },
        dueDate: null,
        version: 2,
      },
    });
    const entries = (await auditLog(owner, number)).slice(0, 4).map((e) => [e.action, e.target, e.before, e.after]);
    expect(entries).toEqual(
      expect.arrayContaining([
        ["task.title_changed", "Contain host", "Contain host", "Contain FIN-LT-0231"],
        ["task.description_changed", "Contain host", "", "From the Falcon console"],
        ["task.owner_changed", "Contain host", "Ana Analyst", "Ben Analyst"],
        ["task.due_date_changed", "Contain host", "2026-01-05", null],
      ]),
    );
  });

  test("an edit based on a stale version is refused with a conflict carrying the current Task", async () => {
    const { ana, ben, open, task, edit, auditLog } = await acme();
    const number = await open();
    const created = await task(ana, number);
    await edit(ana, number, created.id, { title: "Contain host now", version: 1 });
    const before = await auditLog(ana, number);

    const { status, body } = await edit(ben, number, created.id, { title: "Contain host later", version: 1 });
    expect(status).toBe(409);
    expect(body).toMatchObject({
      error: "The Task changed since you opened it",
      current: { id: created.id, title: "Contain host now", version: 2 },
    });
    expect(await auditLog(ana, number)).toEqual(before);
  });

  test("an edit that changes nothing records nothing and keeps the version", async () => {
    const { owner, open, task, edit, auditLog } = await acme();
    const number = await open();
    const created = await task(owner, number, { title: "Contain host" });
    const before = await auditLog(owner, number);
    const { body } = await edit(owner, number, created.id, { title: "Contain host", version: 1 });
    expect(body).toMatchObject({ task: { version: 1 } });
    expect(await auditLog(owner, number)).toEqual(before);
  });

  test("a Task on another Case, or that doesn't exist, is not found", async () => {
    const { owner, open, task, edit } = await acme();
    const one = await open();
    const other = await open();
    const created = await task(owner, one);
    expect((await edit(owner, other, created.id, { title: "x", version: 1 })).status).toBe(404);
    expect((await edit(owner, one, "nope", { title: "x", version: 1 })).status).toBe(404);
  });
});

describe("Completing and reopening Tasks", () => {
  test("a Task is marked done, recording who and when, and reopened; each in the Audit Log", async () => {
    const { t, ana, ben, userId, open, task, setDone, auditLog } = await acme();
    const number = await open();
    const created = await task(ben, number, { title: "Contain host" });

    const done = await setDone(ana, number, created.id, true);
    expect(done).toMatchObject({
      status: 200,
      body: { task: { done: true, completed: { by: { id: await userId(ana), name: "Ana Analyst" }, at: t.clock.now().toISOString() } } },
    });
    const reopened = await setDone(ben, number, created.id, false);
    expect(reopened).toMatchObject({ status: 200, body: { task: { done: false, completed: null } } });

    const entries = (await auditLog(ben, number)).slice(0, 2).map((e) => [e.action, e.actor.name, e.target]);
    expect(entries).toEqual([
      ["task.reopened", "Ben Analyst", "Contain host"],
      ["task.completed", "Ana Analyst", "Contain host"],
    ]);
  });

  test("marking a done Task done again changes nothing", async () => {
    const { owner, open, task, setDone, auditLog } = await acme();
    const number = await open();
    const created = await task(owner, number);
    await setDone(owner, number, created.id, true);
    const before = await auditLog(owner, number);
    expect((await setDone(owner, number, created.id, true)).status).toBe(200);
    expect(await auditLog(owner, number)).toEqual(before);
  });

  test("completing doesn't move the version, so an open edit still saves", async () => {
    const { owner, open, task, setDone, edit } = await acme();
    const number = await open();
    const created = await task(owner, number);
    await setDone(owner, number, created.id, true);
    expect((await edit(owner, number, created.id, { title: "Contain host (done)", version: 1 })).status).toBe(200);
  });
});

describe("Overdue Tasks", () => {
  test("a Task not done by its due date is overdue; a done one never is", async () => {
    const { t, owner, open, task, setDone, list } = await acme();
    // The fake clock starts on 2026-01-01.
    const number = await open();
    const late = await task(owner, number, { title: "Capture memory image", dueDate: "2026-01-02" });
    const finished = await task(owner, number, { title: "Contain host", dueDate: "2026-01-02" });
    await setDone(owner, number, finished.id, true);
    const overdue = async () => {
      const { body } = await list(owner, number);
      return "tasks" in body ? body.tasks.filter((x) => x.overdue).map((x) => x.id) : [];
    };
    t.clock.advance(DAY);
    expect(await overdue()).toEqual([]);
    t.clock.advance(DAY);
    expect(await overdue()).toEqual([late.id]);
  });
});

describe("Tasks on a Closed Case", () => {
  test("are read-only: creating, editing, completing and reopening are refused", async () => {
    const { owner, open, task, create, edit, setDone, list } = await acme();
    const number = await open();
    const created = await task(owner, number);
    await owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "true_positive" } });

    expect((await create(owner, number)).status).toBe(409);
    expect((await edit(owner, number, created.id, { title: "x", version: 1 })).status).toBe(409);
    expect((await setDone(owner, number, created.id, true)).status).toBe(409);
    expect((await list(owner, number)).status).toBe(200);
  });
});

describe("Who can see a Case's Tasks", () => {
  test("an Analyst who can't see a Restricted Case can neither list nor change its Tasks", async () => {
    const { owner, ana, ben, open, task, create, edit, setDone, list, change, userId } = await acme();
    const number = await open();
    const created = await task(owner, number);
    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    expect((await list(ben, number)).status).toBe(404);
    expect((await create(ben, number)).status).toBe(404);
    expect((await edit(ben, number, created.id, { title: "x", version: 1 })).status).toBe(404);
    expect((await setDone(ben, number, created.id, true)).status).toBe(404);
  });

  test("another Organization's Members get not found", async () => {
    const { t, owner, open, task, list, setDone } = await acme();
    const number = await open();
    const created = await task(owner, number);
    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    expect((await list(globex, number)).status).toBe(404);
    expect((await setDone(globex, number, created.id, true)).status).toBe(404);
  });
});

describe("Tasks cannot be deleted", () => {
  test("there is no delete route, and the database refuses DELETE and TRUNCATE", async () => {
    const { t, owner, open, task } = await acme();
    const number = await open();
    const created = await task(owner, number);
    // The RPC client has no `$delete` here because the route doesn't exist; it still sends one.
    const route = owner.api.cases[":number"].tasks[":id"] as unknown as {
      $delete: (args: { param: { number: string; id: string } }) => Promise<Response>;
    };
    expect((await route.$delete({ param: { ...param(number), id: created.id } })).status).toBe(404);
    expect(await dbError(t.deps.db.execute(sql`DELETE FROM tasks`))).toMatch(/cannot be deleted/);
    expect(await dbError(t.deps.db.execute(sql`TRUNCATE tasks CASCADE`))).toMatch(/cannot be deleted/);
  });
});
