import { describe, expect, test } from "bun:test";
import { PRESENCE_TIMEOUT_MS } from "./realtime/live";
import type { ServerMessage } from "./realtime/messages";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const param = (number: number) => ({ number: String(number) });

/** Acme Security: the Owner, an Admin, Ana and Ben (Analysts). Plus Globex, another Organization. */
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

  const open = async (as: Member, title = "Departing employee bulk download") => {
    const res = await as.api.cases.$post({ json: { title, caseType: "insider_threat", severity: "high" } });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case.number;
  };

  type Change = Parameters<Member["api"]["cases"][":number"]["$patch"]>[0]["json"];
  const change = async (as: Member, number: number, json: Change) => {
    const res = await as.api.cases[":number"].$patch({ param: param(number), json });
    if (res.status !== 200) throw new Error(`Could not change C-${number}: ${res.status}`);
  };

  /** A Case only the Owner, the Admin and Ana (its Assignee) can see. */
  const restrictedToAna = async () => {
    const number = await open(owner, "Executive mailbox access");
    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    return number;
  };

  const globex = async () => {
    await t.inviteOwner("Globex", "owner@globex.example");
    return t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
  };

  return { t, owner, admin, ana, ben, userId, open, change, restrictedToAna, globex };
}

const caseSignal = (number: number) => (m: ServerMessage) => m.type === "case" && m.number === number;
const presenceOn = (number: number, names: string[]) => (m: ServerMessage) =>
  m.type === "presence" && m.number === number && JSON.stringify(m.viewers.map((v) => v.name)) === JSON.stringify(names);
const signalsAbout = (messages: ServerMessage[], number: number) => messages.filter(caseSignal(number));

describe("Case signals", () => {
  test("opening a Case and changing its Status, Severity or Case Summary signal that Case to colleagues", async () => {
    const { t, owner, ana, open, change } = await acme();
    const live = await t.connect(ana);

    const number = await open(owner);
    expect(await live.next()).toEqual({ type: "case", number });

    await change(owner, number, { status: "in_progress" });
    expect(await live.next()).toEqual({ type: "case", number });

    await change(owner, number, { severity: "critical" });
    expect(await live.next()).toEqual({ type: "case", number });

    await owner.api.cases[":number"].summary.$put({
      param: param(number),
      json: { summary: { type: "doc", content: [] }, version: 1 },
    });
    expect(await live.next()).toEqual({ type: "case", number });

    await owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "benign" } });
    expect(await live.next()).toEqual({ type: "case", number });
    await owner.api.cases[":number"].reopen.$post({ param: param(number) });
    expect(await live.next()).toEqual({ type: "case", number });
  });

  test("creating, editing and completing a Task signal its Case", async () => {
    const { t, owner, ana, open, userId } = await acme();
    const number = await open(owner);
    const live = await t.connect(ana);
    const tasks = owner.api.cases[":number"].tasks;
    const res = await tasks.$post({ param: param(number), json: { title: "Contain host", ownerId: await userId(ana) } });
    const body = await res.json();
    if (!("task" in body)) throw new Error("Could not create a Task");
    expect(await live.next()).toEqual({ type: "case", number });
    await tasks[":id"].$patch({ param: { ...param(number), id: body.task.id }, json: { title: "Contain FIN-LT-0231", version: 1 } });
    expect(await live.next()).toEqual({ type: "case", number });
    await tasks[":id"].done.$put({ param: { ...param(number), id: body.task.id }, json: { done: true } });
    expect(await live.next()).toEqual({ type: "case", number });
  });

  test("posting, editing and retracting a Discussion message signal its Case", async () => {
    const { t, owner, ana, open } = await acme();
    const number = await open(owner);
    const live = await t.connect(ana);
    const discussion = owner.api.cases[":number"].discussion;
    const body = await (await discussion.$post({ param: param(number), json: { body: "Contained." } })).json();
    if (!("message" in body)) throw new Error("Could not post");
    expect(await live.next()).toEqual({ type: "case", number });
    await discussion[":id"].$patch({ param: { ...param(number), id: body.message.id }, json: { body: "Contained from Falcon." } });
    expect(await live.next()).toEqual({ type: "case", number });
    await discussion[":id"].retract.$post({ param: { ...param(number), id: body.message.id } });
    expect(await live.next()).toEqual({ type: "case", number });
  });

  test("signals name only what changed", async () => {
    const { t, owner, ana, open } = await acme();
    const live = await t.connect(ana);
    const number = await open(owner, "Something secret in the title");
    expect(await live.next()).toStrictEqual({ type: "case", number });
  });

  test("a change that is no change sends nothing", async () => {
    const { t, owner, ana, open, change } = await acme();
    const first = await open(owner);
    const second = await open(owner, "Another");
    const live = await t.connect(ana);
    await change(owner, first, { status: "new" });
    await change(owner, second, { status: "triage" });
    await live.next(caseSignal(second));
    expect(signalsAbout(live.messages, first)).toEqual([]);
  });

  test("signals reach sockets on another server instance, through Postgres", async () => {
    const { t, owner, ana, open, change } = await acme();
    const other = await t.anotherInstance();
    const live = await other.connect(ana);
    const number = await open(owner);
    expect(await live.next()).toEqual({ type: "case", number });
    await change(owner, number, { status: "triage" });
    expect(await live.next()).toEqual({ type: "case", number });
  });
});

describe("Signals are forwarded only to those who can see the Case", () => {
  test("a Restricted Case's signals reach the Owner, Admins and its Assignee, and are withheld from other Analysts", async () => {
    const { t, owner, admin, ana, ben, open, change, restrictedToAna } = await acme();
    const restricted = await restrictedToAna();
    const visible = await open(owner, "Phishing wave");
    const sockets = {
      owner: await t.connect(owner),
      admin: await t.connect(admin),
      ana: await t.connect(ana),
      ben: await t.connect(ben),
    };

    await change(owner, restricted, { severity: "critical" });
    // A signal everyone gets, after the one under test: once it arrives, the first has been handled.
    await change(owner, visible, { severity: "low" });

    for (const name of ["owner", "admin", "ana"] as const) {
      await sockets[name].next(caseSignal(visible));
      expect(signalsAbout(sockets[name].messages, restricted)).toHaveLength(1);
    }
    await sockets.ben.next(caseSignal(visible));
    expect(signalsAbout(sockets.ben.messages, restricted)).toEqual([]);
  });

  test("withheld on other instances too", async () => {
    const { t, owner, ben, open, change, restrictedToAna } = await acme();
    const restricted = await restrictedToAna();
    const visible = await open(owner, "Phishing wave");
    const live = await (await t.anotherInstance()).connect(ben);
    await change(owner, restricted, { severity: "critical" });
    await change(owner, visible, { severity: "low" });
    await live.next(caseSignal(visible));
    expect(signalsAbout(live.messages, restricted)).toEqual([]);
  });

  test("another Organization's Cases are never signalled", async () => {
    const { t, owner, open, change, globex } = await acme();
    const gil = await globex();
    const live = await t.connect(gil);
    const acmeCase = await open(owner);
    await change(owner, acmeCase, { status: "triage" });
    const globexCase = await open(gil, "Globex's own");
    expect(await live.next()).toEqual({ type: "case", number: globexCase });
    // Globex's C-1 and Acme's C-1 share a number; Gil heard only about his own.
    expect(live.messages).toEqual([{ type: "case", number: globexCase }]);
  });

  test("an Analyst hears that a Case they could see became Restricted, and nothing after", async () => {
    const { t, owner, ana, ben, open, change, userId } = await acme();
    const number = await open(owner);
    const marker = await open(owner, "Phishing wave");
    const live = await t.connect(ben);

    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    expect(await live.next()).toEqual({ type: "case", number });

    await change(owner, number, { severity: "critical" });
    await change(owner, marker, { severity: "low" });
    await live.next(caseSignal(marker));
    expect(signalsAbout(live.messages, number)).toHaveLength(1);
  });

  test("an Analyst newly assigned to a Restricted Case starts hearing about it", async () => {
    const { t, owner, ben, change, userId, restrictedToAna } = await acme();
    const number = await restrictedToAna();
    const live = await t.connect(ben);
    await change(owner, number, { assigneeId: await userId(ben) });
    expect(await live.next()).toEqual({ type: "case", number });
  });

  test("an Analyst given a Case Role on a Restricted Case starts hearing about it; hears it taken away, and nothing after", async () => {
    const { t, owner, admin, ben, open, change, userId, restrictedToAna } = await acme();
    const number = await restrictedToAna();
    const marker = await open(owner, "Phishing wave");
    const roleRes = await admin.api.organization["case-roles"].$post({ json: { name: "Forensics" } });
    const roleBody = await roleRes.json();
    if (!("caseRole" in roleBody)) throw new Error("Could not create a Case Role");
    const live = await t.connect(ben);

    const assigned = await owner.api.cases[":number"]["case-roles"].$post({
      param: param(number),
      json: { caseRoleId: roleBody.caseRole.id, userId: await userId(ben) },
    });
    const assignedBody = await assigned.json();
    if (!("caseRoles" in assignedBody)) throw new Error("Could not give the Case Role");
    expect(await live.next()).toEqual({ type: "case", number });

    await owner.api.cases[":number"]["case-roles"][":assignmentId"].$delete({
      param: { ...param(number), assignmentId: assignedBody.caseRoles[0]!.id },
    });
    expect(await live.next()).toEqual({ type: "case", number });

    await change(owner, number, { severity: "critical" });
    await change(owner, marker, { severity: "low" });
    await live.next(caseSignal(marker));
    expect(signalsAbout(live.messages, number)).toHaveLength(2);
  });

  test("a removed Member's socket is closed and hears nothing more", async () => {
    const { t, owner, ben, open } = await acme();
    const live = await t.connect(ben);
    const { members } = await (await owner.api.organization.members.$get()).json();
    const benMember = members.find((m) => m.name === "Ben Analyst")!;
    await owner.api.organization.members[":id"].$delete({ param: { id: benMember.id } });
    expect((await live.closed).code).toBe(4403);
    await open(owner);
    expect(live.messages).toEqual([]);
  });

  test("an Analyst promoted to Admin is told to refetch, and then hears about Restricted Cases", async () => {
    const { t, owner, ben, change, restrictedToAna } = await acme();
    const number = await restrictedToAna();
    const live = await t.connect(ben);
    const { members } = await (await owner.api.organization.members.$get()).json();
    const benMember = members.find((m) => m.name === "Ben Analyst")!;
    await owner.api.organization.members[":id"].$patch({ param: { id: benMember.id }, json: { role: "admin" } });
    expect(await live.next()).toEqual({ type: "resync" });
    await change(owner, number, { severity: "critical" });
    expect(await live.next()).toEqual({ type: "case", number });
  });
});

describe("The live socket", () => {
  test("is refused when signed out", async () => {
    const { t } = await acme();
    await expect(t.connect(t.session())).rejects.toThrow();
  });

  test("is refused from another site's pages", async () => {
    const { t, ana } = await acme();
    await expect(t.connect(ana, { origin: "https://evil.example" })).rejects.toThrow();
  });

  test("ignores messages it doesn't understand", async () => {
    const { t, owner, ana, open } = await acme();
    const live = await t.connect(ana);
    live.send({ type: "nonsense" } as never);
    live.send({ type: "view", number: -1 });
    const number = await open(owner);
    expect(await live.next()).toEqual({ type: "case", number });
  });
});

describe("Presence", () => {
  test("viewers of a Case see each other arrive and leave", async () => {
    const { t, owner, ana, open } = await acme();
    const number = await open(owner);
    const olive = await t.connect(owner);
    const anaLive = await t.connect(ana);

    olive.send({ type: "view", number });
    await olive.next(presenceOn(number, ["Olive Owner"]));

    anaLive.send({ type: "view", number });
    await olive.next(presenceOn(number, ["Ana Analyst", "Olive Owner"]));
    await anaLive.next(presenceOn(number, ["Ana Analyst", "Olive Owner"]));

    await anaLive.close();
    await olive.next(presenceOn(number, ["Olive Owner"]));
  });

  test("moving to another Case, or off Case pages, leaves the first", async () => {
    const { t, owner, ana, open } = await acme();
    const first = await open(owner);
    const second = await open(owner, "Another");
    const olive = await t.connect(owner);
    const anaLive = await t.connect(ana);
    olive.send({ type: "view", number: first });
    anaLive.send({ type: "view", number: first });
    await olive.next(presenceOn(first, ["Ana Analyst", "Olive Owner"]));

    anaLive.send({ type: "view", number: second });
    await olive.next(presenceOn(first, ["Olive Owner"]));
    await anaLive.next(presenceOn(second, ["Ana Analyst"]));

    anaLive.send({ type: "view", number: first });
    await olive.next(presenceOn(first, ["Ana Analyst", "Olive Owner"]));
    anaLive.send({ type: "view", number: null });
    await olive.next(presenceOn(first, ["Olive Owner"]));
  });

  test("someone with the Case open in two tabs shows once, until both close", async () => {
    const { t, owner, ana, open } = await acme();
    const number = await open(owner);
    const olive = await t.connect(owner);
    olive.send({ type: "view", number });
    const tabs = [await t.connect(ana), await t.connect(ana)];
    for (const tab of tabs) tab.send({ type: "view", number });
    await olive.next(presenceOn(number, ["Ana Analyst", "Olive Owner"]));
    await olive.next(presenceOn(number, ["Ana Analyst", "Olive Owner"]));
    await tabs[0]!.close();
    await olive.next(presenceOn(number, ["Ana Analyst", "Olive Owner"]));
    await tabs[1]!.close();
    await olive.next(presenceOn(number, ["Olive Owner"]));
  });

  test("viewers on another server instance show too", async () => {
    const { t, owner, ana, open } = await acme();
    const number = await open(owner);
    const olive = await t.connect(owner);
    const anaLive = await (await t.anotherInstance()).connect(ana);
    olive.send({ type: "view", number });
    anaLive.send({ type: "view", number });
    await olive.next(presenceOn(number, ["Ana Analyst", "Olive Owner"]));
    await anaLive.next(presenceOn(number, ["Ana Analyst", "Olive Owner"]));
    await anaLive.close();
    await olive.next(presenceOn(number, ["Olive Owner"]));
  });

  test("an Analyst can't appear on, or watch presence of, a Restricted Case they can't see", async () => {
    const { t, owner, ben, open, restrictedToAna } = await acme();
    const number = await restrictedToAna();
    const visible = await open(owner, "Phishing wave");
    const olive = await t.connect(owner);
    const benLive = await t.connect(ben);
    olive.send({ type: "view", number });
    await olive.next(presenceOn(number, ["Olive Owner"]));

    benLive.send({ type: "view", number });
    benLive.send({ type: "view", number: visible });
    await benLive.next(presenceOn(visible, ["Ben Analyst"]));
    expect(benLive.messages.filter((m) => m.type === "presence" && m.number === number)).toEqual([]);
    // Olive saw no change on the Restricted Case.
    expect(olive.messages.filter((m) => m.type === "presence" && m.number === number)).toHaveLength(1);
  });

  test("an Analyst viewing a Case that becomes Restricted drops off its viewers", async () => {
    const { t, owner, ana, ben, open, change, userId } = await acme();
    const number = await open(owner);
    const olive = await t.connect(owner);
    const benLive = await t.connect(ben);
    olive.send({ type: "view", number });
    benLive.send({ type: "view", number });
    await olive.next(presenceOn(number, ["Ben Analyst", "Olive Owner"]));

    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    await olive.next(presenceOn(number, ["Olive Owner"]));
    await benLive.next(caseSignal(number));
  });

  test("viewers left behind by a server instance that died expire", async () => {
    const { t, owner, ana, open } = await acme();
    const number = await open(owner);
    const olive = await t.connect(owner);
    olive.send({ type: "view", number });
    await olive.next(presenceOn(number, ["Olive Owner"]));

    // Ana's instance stops refreshing her presence, as if it had crashed.
    const other = await t.anotherInstance();
    const anaLive = await other.connect(ana);
    anaLive.send({ type: "view", number });
    await olive.next(presenceOn(number, ["Ana Analyst", "Olive Owner"]));

    t.clock.advance(PRESENCE_TIMEOUT_MS / 2);
    await t.live.sweep();
    t.clock.advance(PRESENCE_TIMEOUT_MS / 2 + 1_000);
    await t.live.sweep();
    await olive.next(presenceOn(number, ["Olive Owner"]));
  });
});
