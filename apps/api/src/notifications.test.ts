import { describe, expect, test } from "bun:test";
import { createNotificationWorker } from "./notifications/notifications";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const DAY = 24 * 60 * 60 * 1000;
const COUNSEL = "k.patel@lawfirm.example";
const param = (number: number) => ({ number: String(number) });

/** Acme Security: its Owner, Ana and Ben (Analysts), signed in, and helpers to work Cases and read notifications. */
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

  const userId = async (as: Session) => {
    const me = await (await as.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  };
  const ids = { owner: await userId(owner), ana: await userId(ana), ben: await userId(ben) };

  const open = async (as: Session = owner, severity: "high" | "critical" = "high") => {
    const res = await as.api.cases.$post({ json: { title: "Suspicious PowerShell", caseType: "malware", severity } });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case.number;
  };
  type Change = Parameters<Session["api"]["cases"][":number"]["$patch"]>[0]["json"];
  const change = async (as: Session, number: number, json: Change) => {
    const res = await as.api.cases[":number"].$patch({ param: param(number), json });
    if (res.status !== 200) throw new Error(`Could not change the Case: ${res.status} ${await res.text()}`);
  };

  type NewTask = Parameters<Session["api"]["cases"][":number"]["tasks"]["$post"]>[0]["json"];
  const task = async (as: Session, number: number, json: Partial<NewTask> = {}) => {
    const res = await as.api.cases[":number"].tasks.$post({ param: param(number), json: { title: "Contain host", ownerId: ids.ana, ...json } });
    const body = await res.json();
    if (!("task" in body)) throw new Error(`Could not create a Task: ${res.status} ${JSON.stringify(body)}`);
    return body.task;
  };

  const post = async (as: Session, number: number, body: string, internal = false) => {
    const res = await as.api.cases[":number"].discussion.$post({ param: param(number), json: { body, internal } });
    const json = await res.json();
    if (!("message" in json)) throw new Error(`Could not post: ${res.status} ${JSON.stringify(json)}`);
    return json.message;
  };

  const inviteCounsel = async (number: number) => {
    const res = await owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel" } });
    const body = await res.json();
    if (!("guests" in body)) throw new Error(`Could not invite counsel: ${res.status}`);
    return body.guests.find((g) => g.guest.email === COUNSEL)!;
  };

  const notifications = async (as: Session) => {
    const res = await as.api.notifications.$get();
    const body = await res.json();
    if (!("notifications" in body)) throw new Error(`Could not read notifications: ${res.status}`);
    return body;
  };
  const kinds = async (as: Session) => (await notifications(as)).notifications.map((n) => n.kind);
  /** The notification emails sent to `email`. */
  const emailsTo = (email: string) => t.outbox.messages.filter((m) => m.to === email && m.subject.endsWith("· Argus"));

  const worker = createNotificationWorker(t.deps);

  return { t, owner, ana, ben, ids, userId, open, change, task, post, inviteCounsel, notifications, kinds, emailsTo, worker };
}

describe("Assigned as Case Assignee", () => {
  test("the new Assignee is notified in-app and by email, with a link to the Case", async () => {
    const { owner, ana, ids, open, change, notifications, emailsTo } = await acme();
    const number = await open();
    await change(owner, number, { assigneeId: ids.ana });

    const { notifications: list, unread } = await notifications(ana);
    expect(unread).toBe(1);
    expect(list).toEqual([
      expect.objectContaining({
        kind: "case_assigned",
        headline: `Olive Owner made you Assignee of C-${number}`,
        case: { number, title: "Suspicious PowerShell" },
        section: null,
        actor: { id: ids.owner, name: "Olive Owner" },
        read: false,
      }),
    ]);
    const [email] = emailsTo("ana@acme.example");
    expect(email?.subject).toBe(`Olive Owner made you Assignee of C-${number} · Argus`);
    expect(email?.text).toContain(`C-${number} · Suspicious PowerShell at Acme Security`);
    expect(email?.text).toContain(`http://argus.test/cases/${number}`);
  });

  test("nobody is notified for assigning themself, or for unassigning", async () => {
    const { owner, ana, ids, open, change, kinds, emailsTo } = await acme();
    const number = await open();
    await change(ana, number, { assigneeId: ids.ana });
    await change(owner, number, { assigneeId: null });
    expect(await kinds(ana)).toEqual([]);
    expect(await kinds(owner)).toEqual([]);
    expect(emailsTo("ana@acme.example")).toEqual([]);
  });
});

describe("Assigned as Task owner", () => {
  test("the owner is notified when a Task is created for them, and the new owner when it changes hands", async () => {
    const { owner, ana, ben, ids, open, task, notifications, kinds, emailsTo } = await acme();
    const number = await open();
    const created = await task(owner, number, { title: "Image the laptop" });

    const [n] = (await notifications(ana)).notifications;
    expect(n).toMatchObject({
      kind: "task_assigned",
      headline: `Olive Owner gave you the Task "Image the laptop" on C-${number}`,
      section: "tasks",
      task: { id: created.id, title: "Image the laptop" },
    });
    expect(emailsTo("ana@acme.example")[0]?.text).toContain(`http://argus.test/cases/${number}/tasks`);

    await owner.api.cases[":number"].tasks[":id"].$patch({
      param: { ...param(number), id: created.id },
      json: { ownerId: ids.ben, version: created.version },
    });
    expect(await kinds(ben)).toEqual(["task_assigned"]);
    expect(await kinds(ana)).toEqual(["task_assigned"]);
  });

  test("nobody is notified for a Task they give themself", async () => {
    const { ana, open, task, kinds } = await acme();
    const number = await open(ana);
    await task(ana, number);
    expect(await kinds(ana)).toEqual([]);
  });
});

describe("@mentioned", () => {
  test("everyone a message mentions is notified, but not its author; an edit notifies only those it newly mentions", async () => {
    const { owner, ana, ben, ids, open, post, notifications, kinds, emailsTo } = await acme();
    const number = await open();
    const message = await post(owner, number, `<@${ids.ana}> and <@${ids.owner}>, look at this`);

    expect((await notifications(ana)).notifications).toEqual([
      expect.objectContaining({ kind: "mentioned", headline: `Olive Owner mentioned you on C-${number}`, section: "timeline" }),
    ]);
    expect(await kinds(owner)).toEqual([]);
    expect(emailsTo("ana@acme.example")[0]?.text).toContain(`http://argus.test/cases/${number}/timeline`);

    await owner.api.cases[":number"].discussion[":id"].$patch({
      param: { ...param(number), id: message.id },
      json: { body: `<@${ids.ana}>, <@${ids.ben}>: look at this` },
    });
    expect(await kinds(ana)).toEqual(["mentioned"]);
    expect(await kinds(ben)).toEqual(["mentioned"]);
  });

  test("a Guest is notified of a mention, in-app and by email", async () => {
    const { t, owner, open, post, inviteCounsel, notifications, emailsTo } = await acme();
    const number = await open();
    const grant = await inviteCounsel(number);
    await post(owner, number, `<@${grant.guest.id}> please review`);
    const guest = await t.guestSignIn(COUNSEL);
    expect((await notifications(guest)).notifications.map((n) => n.kind)).toEqual(["mentioned"]);
    expect(emailsTo(COUNSEL)).toHaveLength(1);
  });
});

describe("Guest added to your Case", () => {
  test("the Assignee is notified when someone else adds a Guest", async () => {
    const { owner, ana, ids, open, change, inviteCounsel, notifications, kinds } = await acme();
    const number = await open();
    await change(owner, number, { assigneeId: ids.ana });
    await inviteCounsel(number);
    const { notifications: list } = await notifications(ana);
    expect(list[0]).toMatchObject({ kind: "guest_added", headline: `Olive Owner added Kim Patel to C-${number} as a Guest` });
    expect(await kinds(owner)).toEqual([]);
  });

  test("an unassigned Case notifies nobody", async () => {
    const { owner, ana, open, inviteCounsel, kinds } = await acme();
    const number = await open();
    await inviteCounsel(number);
    expect(await kinds(ana)).toEqual([]);
    expect(await kinds(owner)).toEqual([]);
  });
});

describe("Severity raised to Critical", () => {
  test("the Assignee, Case Role holders and Guests are notified, but not whoever raised it", async () => {
    const { t, owner, ana, ben, ids, open, change, inviteCounsel, kinds } = await acme();
    const number = await open();
    await change(owner, number, { assigneeId: ids.ana });
    const role = await (await owner.api.organization["case-roles"].$post({ json: { name: "Forensics" } })).json();
    if (!("caseRole" in role)) throw new Error("Could not create a Case Role");
    await owner.api.cases[":number"]["case-roles"].$post({ param: param(number), json: { caseRoleId: role.caseRole.id, userId: ids.ben } });
    await inviteCounsel(number);

    await change(ana, number, { severity: "critical" });
    expect(await kinds(ben)).toEqual(["severity_critical"]);
    expect(await kinds(await t.guestSignIn(COUNSEL))).toEqual(["severity_critical"]);
    expect((await kinds(ana)).includes("severity_critical")).toBe(false);
    // The Owner isn't taking part in the Case.
    expect(await kinds(owner)).toEqual([]);
  });

  test("other Severity changes notify nobody", async () => {
    const { owner, ana, ids, open, change, kinds } = await acme();
    const number = await open(owner, "critical");
    await change(owner, number, { assigneeId: ids.ana });
    await change(owner, number, { severity: "medium" });
    expect(await kinds(ana)).toEqual(["case_assigned"]);
  });
});

describe("Task overdue", () => {
  test("the owner is notified once its due date has passed, once per due date", async () => {
    const { t, owner, ana, open, task, notifications, kinds, emailsTo, worker } = await acme();
    const number = await open();
    // The clock starts on 2026-01-01.
    const created = await task(owner, number, { title: "Image the laptop", dueDate: "2026-01-02" });
    await task(owner, number, { title: "Undated" });

    await worker.tick();
    t.clock.advance(DAY);
    await worker.tick();
    expect(await kinds(ana)).toEqual(["task_assigned", "task_assigned"]);

    t.clock.advance(DAY);
    await worker.tick();
    await worker.tick();
    const { notifications: list } = await notifications(ana);
    expect(list[0]).toMatchObject({
      kind: "task_overdue",
      headline: `Your Task "Image the laptop" on C-${number} is overdue`,
      actor: null,
      task: { id: created.id },
    });
    expect(list.filter((n) => n.kind === "task_overdue")).toHaveLength(1);
    const overdueEmails = emailsTo("ana@acme.example").filter((m) => m.subject.includes("overdue"));
    expect(overdueEmails).toHaveLength(1);
    expect(overdueEmails[0]?.text).toContain("It was due 2026-01-02.");

    // A new due date that passes too is told again.
    const tasks = await (await owner.api.cases[":number"].tasks.$get({ param: param(number) })).json();
    if (!("tasks" in tasks)) throw new Error("Could not list Tasks");
    const version = tasks.tasks.find((x) => x.id === created.id)!.version;
    await owner.api.cases[":number"].tasks[":id"].$patch({ param: { ...param(number), id: created.id }, json: { dueDate: "2026-01-04", version } });
    t.clock.advance(2 * DAY);
    await worker.tick();
    expect((await kinds(ana)).filter((k) => k === "task_overdue")).toHaveLength(2);
  });

  test("done Tasks, and Tasks on Closed Cases, are not overdue", async () => {
    const { t, owner, ana, open, task, kinds, worker } = await acme();
    const number = await open();
    const done = await task(owner, number, { dueDate: "2026-01-02" });
    await ana.api.cases[":number"].tasks[":id"].done.$put({ param: { ...param(number), id: done.id }, json: { done: true } });
    const closed = await open();
    await task(owner, closed, { dueDate: "2026-01-02" });
    await owner.api.cases[":number"].close.$post({ param: param(closed), json: { resolution: "benign" } });

    t.clock.advance(3 * DAY);
    await worker.tick();
    expect((await kinds(ana)).filter((k) => k === "task_overdue")).toEqual([]);
  });

  test("a Guest who has been removed from the Case is not told their Task is overdue", async () => {
    const { t, owner, open, task, inviteCounsel, emailsTo, worker } = await acme();
    const number = await open();
    const grant = await inviteCounsel(number);
    await task(owner, number, { ownerId: grant.guest.id, dueDate: "2026-01-02" });
    await owner.api.cases[":number"].guests[":id"].$delete({ param: { ...param(number), id: grant.id } });

    t.clock.advance(3 * DAY);
    await worker.tick();
    expect(emailsTo(COUNSEL).filter((m) => m.subject.includes("overdue"))).toEqual([]);
  });
});

describe("Visibility", () => {
  test("a Member who loses sight of a Restricted Case no longer sees its notifications", async () => {
    const { owner, ana, ids, open, post, notifications } = await acme();
    const number = await open();
    await post(owner, number, `<@${ids.ana}> have a look`);
    expect((await notifications(ana)).unread).toBe(1);

    await owner.api.cases[":number"].$patch({ param: param(number), json: { restricted: true } });
    expect(await notifications(ana)).toEqual({ notifications: [], unread: 0 });
  });

  test("Members of a Restricted Case who aren't assigned to it aren't told its Severity was raised", async () => {
    const { owner, ana, ben, ids, open, change, kinds } = await acme();
    const number = await open();
    await change(owner, number, { assigneeId: ids.ana, restricted: true });
    await change(owner, number, { severity: "critical" });
    expect(await kinds(ana)).toEqual(["severity_critical", "case_assigned"]);
    expect(await kinds(ben)).toEqual([]);
  });

  test("a Guest is never notified about an Internal item, and no longer sees notifications once removed", async () => {
    const { t, owner, open, post, task, inviteCounsel, notifications } = await acme();
    const number = await open();
    const grant = await inviteCounsel(number);
    const message = await post(owner, number, `<@${grant.guest.id}> please review`);
    await task(owner, number, { ownerId: grant.guest.id });
    const guest = await t.guestSignIn(COUNSEL);
    expect((await notifications(guest)).unread).toBe(2);

    // What they were told about can't be hidden from them, so what they see stays true.
    for (const item of [
      { kind: "discussion_message" as const, id: message.id },
      { kind: "task" as const, id: (await notifications(guest)).notifications[0]!.task!.id },
    ]) {
      const res = await owner.api.cases[":number"].internal.$put({ param: param(number), json: { item, internal: true } });
      expect(res.status).toBe(400);
    }
    const internal = await owner.api.cases[":number"].discussion.$post({
      param: param(number),
      json: { body: `<@${grant.guest.id}> members only`, internal: true },
    });
    expect(internal.status).toBe(400);
    expect((await notifications(guest)).unread).toBe(2);

    await owner.api.cases[":number"].guests[":id"].$delete({ param: { ...param(number), id: grant.id } });
    // Removed from their only Case, they are signed out.
    expect((await guest.api.notifications.$get()).status as number).toBe(401);
  });
});

describe("Read and unread", () => {
  test("each recipient marks their own notifications read, one at a time or all at once", async () => {
    const { owner, ana, ben, ids, open, post, notifications } = await acme();
    const number = await open();
    await post(owner, number, `<@${ids.ana}> <@${ids.ben}> first`);
    await post(owner, number, `<@${ids.ana}> second`);

    const [latest, earlier] = (await notifications(ana)).notifications;
    expect((await ben.api.notifications[":id"].read.$post({ param: { id: latest!.id } })).status).toBe(404);
    const res = await ana.api.notifications[":id"].read.$post({ param: { id: latest!.id } });
    const body = await res.json();
    expect(res.status).toBe(200);
    if (!("unread" in body)) throw new Error("Could not mark read");
    expect(body.unread).toBe(1);
    expect(body.notifications.map((n) => [n.id, n.read])).toEqual([
      [latest!.id, true],
      [earlier!.id, false],
    ]);
    expect((await notifications(ben)).unread).toBe(1);

    await ana.api.notifications.read.$post();
    expect((await notifications(ana)).unread).toBe(0);
    expect((await notifications(ben)).unread).toBe(1);
  });
});

describe("Live", () => {
  test("the recipient's socket hears their notifications changed; nobody else's does", async () => {
    const { t, owner, ana, ben, ids, open, post } = await acme();
    const number = await open();
    const anaLive = await t.connect(ana);
    const benLive = await t.connect(ben);
    await post(owner, number, `<@${ids.ana}> look`);
    expect(await anaLive.next((m) => m.type === "notifications")).toEqual({ type: "notifications" });
    await t.live.settled();
    expect(benLive.messages.filter((m) => m.type === "notifications")).toEqual([]);
  });
});
