import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const param = (number: number) => ({ number: String(number) });
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const COUNSEL = "k.patel@lawfirm.example";

/** Acme Security: the Owner, an Admin, Ana (an Analyst, the Assignee) and Ben (an Analyst who isn't), signed in. */
async function acme() {
  const t = await buildTestApp();
  const organization = async (name: string, ownerEmail: string, ownerName: string) => {
    await t.inviteOwner(name, ownerEmail);
    return t.acceptInvite(ownerEmail, PASSWORD, ownerName);
  };
  const owner = await organization("Acme Security", "owner@acme.example", "Olive Owner");
  const join = async (email: string, role: "admin" | "analyst", name: string) => {
    await owner.api.organization.invitations.$post({ json: { email, role } });
    return t.acceptInvite(email, PASSWORD, name);
  };
  const admin = await join("adam@acme.example", "admin", "Adam Admin");
  const ana = await join("ana@acme.example", "analyst", "Ana Analyst");
  const ben = await join("ben@acme.example", "analyst", "Ben Analyst");
  type Session = ReturnType<typeof t.session>;

  const userId = async (as: Session) => {
    const me = await (await as.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  };
  const me = async (as: Session) => {
    const res = await as.api.me.$get();
    return { status: res.status, body: await res.json() };
  };

  const open = async (as: Session = owner, title = "Suspicious PowerShell on FIN-LT-0231") => {
    const res = await as.api.cases.$post({ json: { title, caseType: "malware", severity: "high" } });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case.number;
  };
  /** Opens a Case assigned to Ana. */
  const openForAna = async (title?: string) => {
    const number = await open(owner, title);
    await owner.api.cases[":number"].$patch({ param: param(number), json: { assigneeId: await userId(ana) } });
    return number;
  };

  type InviteJson = Parameters<Session["api"]["cases"][":number"]["guests"]["$post"]>[0]["json"];
  const invite = async (as: Session, number: number, json: InviteJson) => {
    const res = await as.api.cases[":number"].guests.$post({ param: param(number), json });
    return { status: res.status, body: await res.json() };
  };
  const guestsOn = async (as: Session, number: number) => {
    const res = await as.api.cases[":number"].guests.$get({ param: param(number) });
    const body = await res.json();
    if (!("guests" in body)) throw new Error(`Could not list Guests: ${res.status}`);
    return body.guests;
  };
  const remove = async (as: Session, number: number, id: string) => {
    const res = await as.api.cases[":number"].guests[":id"].$delete({ param: { ...param(number), id } });
    return { status: res.status, body: await res.json() };
  };
  /** Invites counsel to Case `number`, as the Owner, and returns the grant's id. */
  const inviteCounsel = async (number: number, expiresAt: string | null = null, as: Session = owner) => {
    const { status, body } = await invite(as, number, { email: COUNSEL, name: "Kim Patel", expiresAt });
    if (status !== 201 || !("guests" in body)) throw new Error(`Could not invite counsel: ${status} ${JSON.stringify(body)}`);
    return body.guests.find((g) => g.guest.email === COUNSEL)!.id;
  };

  const view = async (as: Session, number: number) => {
    const res = await as.api.cases[":number"].$get({ param: param(number) });
    return { status: res.status, body: await res.json() };
  };
  const listNumbers = async (as: Session): Promise<number[] | number> => {
    const res = await as.api.cases.$get({ query: {} });
    const body = await res.json();
    return "cases" in body ? body.cases.map((c) => c.number) : res.status;
  };
  const auditLog = async (as: Session, number: number) => {
    const body = await (await as.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };

  return { t, organization, owner, admin, ana, ben, userId, me, open, openForAna, invite, guestsOn, remove, inviteCounsel, view, listNumbers, auditLog };
}

describe("inviting Guests", () => {
  test("an Admin invites a Guest by email; the Guest is emailed a sign-in link and the invite is in the Audit Log", async () => {
    const a = await acme();
    const number = await a.open();
    const expiresAt = new Date(a.t.clock.now().getTime() + 30 * DAY).toISOString();
    const { status, body } = await a.invite(a.admin, number, { email: "K.Patel@LawFirm.example", name: "Kim Patel", expiresAt });
    expect(status).toBe(201);
    if (!("guests" in body)) throw new Error("No Guests");
    expect(body.guests).toEqual([
      {
        id: expect.any(String),
        guest: { id: expect.any(String), name: "Kim Patel", email: COUNSEL },
        expiresAt,
        expired: false,
        invitedBy: { id: await a.userId(a.admin), name: "Adam Admin" },
        invitedAt: a.t.clock.now().toISOString(),
      },
    ]);
    expect(await a.guestsOn(a.ben, number)).toEqual(body.guests);

    const mail = a.t.outbox.messages.findLast((m) => m.to === COUNSEL)!;
    expect(mail.subject).toBe(`You're invited to C-${number} at Acme Security on Argus`);
    expect(mail.text).toContain("Adam Admin invited you to work on C-1 · Suspicious PowerShell on FIN-LT-0231 at Acme Security");
    expect(mail.text).toContain(`http://argus.test/guest/sign-in?email=${encodeURIComponent(COUNSEL)}`);
    expect(mail.text).toContain(`Your access ends ${expiresAt}.`);

    const [entry] = await a.auditLog(a.owner, number);
    expect(entry).toMatchObject({
      actor: { type: "member", name: "Adam Admin" },
      action: "guest.invited",
      target: `Kim Patel <${COUNSEL}>`,
      after: `until ${expiresAt}`,
    });
  });

  test("only Admins, the Owner and the Case's Assignee invite Guests", async () => {
    const a = await acme();
    const number = await a.openForAna();
    expect((await a.invite(a.ben, number, { email: COUNSEL })).status).toBe(403);
    expect((await a.invite(a.ana, number, { email: COUNSEL })).status).toBe(201);
    expect((await a.invite(a.owner, number, { email: "insurer@cover.example" })).status).toBe(201);
    expect((await a.guestsOn(a.ben, number)).map((g) => g.guest.email)).toEqual([COUNSEL, "insurer@cover.example"]);
  });

  test("refuses Members, someone already on the Case, a past expiry and a Closed Case", async () => {
    const a = await acme();
    const number = await a.open();
    const member = await a.invite(a.owner, number, { email: "ben@acme.example" });
    expect(member).toEqual({ status: 400, body: { error: "This email belongs to a Member; Members can't be invited as Guests" } });
    const otherOrg = await a.organization("Globex", "owner@globex.example", "Gus Globex");
    expect((await a.invite(a.owner, number, { email: "owner@globex.example" })).status).toBe(400);
    expect((await a.invite(otherOrg, number, { email: COUNSEL })).status).toBe(404);

    const past = new Date(a.t.clock.now().getTime() - HOUR).toISOString();
    expect(await a.invite(a.owner, number, { email: COUNSEL, expiresAt: past })).toEqual({
      status: 400,
      body: { error: "The access expiry must be in the future" },
    });
    await a.inviteCounsel(number);
    expect(await a.invite(a.owner, number, { email: COUNSEL })).toEqual({
      status: 409,
      body: { error: "They are already a Guest on this Case" },
    });

    const closed = await a.open(a.owner, "Closed one");
    await a.owner.api.cases[":number"].close.$post({ param: param(closed), json: { resolution: "benign" } });
    expect((await a.invite(a.owner, closed, { email: COUNSEL })).status).toBe(409);
  });
});

describe("Guest sign-in", () => {
  test("a Guest signs in with a magic link and sees only the Cases they're invited to", async () => {
    const a = await acme();
    const theirs = await a.open(a.owner, "Theirs");
    const restricted = await a.open(a.owner, "Restricted, but theirs");
    await a.owner.api.cases[":number"].$patch({ param: param(restricted), json: { restricted: true } });
    const notTheirs = await a.open(a.owner, "Not theirs");
    await a.inviteCounsel(theirs);
    await a.inviteCounsel(restricted);

    const guest = await a.t.guestSignIn(COUNSEL);
    const { body } = await a.me(guest);
    expect(body).toMatchObject({
      user: { name: "Kim Patel", email: COUNSEL },
      isOperator: false,
      organization: null,
      guest: {
        organization: { name: "Acme Security" },
        cases: [
          { organization: { name: "Acme Security" }, number: restricted, title: "Restricted, but theirs", expiresAt: null },
          { organization: { name: "Acme Security" }, number: theirs, title: "Theirs", expiresAt: null },
        ],
        sessionEndsAt: new Date(a.t.clock.now().getTime() + 12 * HOUR).toISOString(),
      },
    });
    expect(await a.listNumbers(guest)).toEqual([restricted, theirs]);
    expect((await a.view(guest, theirs)).status).toBe(200);
    expect((await a.view(guest, notTheirs)).status).toBe(404);
    expect((await guest.api.cases[":number"].tasks.$get({ param: param(notTheirs) })).status).toBe(404);
  });

  test("magic links go only to Guests holding a grant, with the same answer for everyone else", async () => {
    const a = await acme();
    await a.inviteCounsel(await a.open());
    const s = a.t.session();
    const sent = a.t.outbox.messages.length;
    for (const email of ["ben@acme.example", "nobody@nowhere.example", "ops@argus.test"]) {
      const res = await s.auth.signIn.magicLink({ email, callbackURL: "/" });
      expect(res.error).toBeNull();
    }
    expect(a.t.outbox.messages.length).toBe(sent);
    expect(await a.t.guestSignIn(COUNSEL)).toBeDefined();
  });

  test("a Member's session can't come from a magic link, and a Guest can't add a password or passkey", async () => {
    const a = await acme();
    await a.inviteCounsel(await a.open());
    const guest = await a.t.guestSignIn(COUNSEL);
    const passkey = await guest.auth.passkey.generateRegisterOptions();
    expect(passkey.error?.status).toBe(403);
    const update = await guest.auth.updateUser({ name: "Someone Else" });
    expect(update.error?.status).toBe(403);
    expect((await guest.auth.getSession()).data?.user.email).toBe(COUNSEL);
  });

  test("a Guest session lasts about 12 hours", async () => {
    const a = await acme();
    await a.inviteCounsel(await a.open());
    const guest = await a.t.guestSignIn(COUNSEL);
    a.t.clock.advance(11 * HOUR);
    expect((await a.me(guest)).status).toBe(200);
    a.t.clock.advance(HOUR);
    expect((await a.me(guest)).status).toBe(401);
    expect(await a.listNumbers(guest)).toBe(401);
    // Signing in again starts a new session.
    const again = await a.t.guestSignIn(COUNSEL);
    expect((await a.me(again)).status).toBe(200);
  });

  test("one Guest account holds grants from several Organizations and switches between them", async () => {
    const a = await acme();
    const acmeCase = await a.open(a.owner, "Acme matter");
    await a.inviteCounsel(acmeCase);
    const globex = await a.organization("Globex", "owner@globex.example", "Gus Globex");
    const globexCase = await a.open(globex, "Globex matter");
    const globexOther = await a.open(globex, "Globex, not theirs");
    expect((await a.invite(globex, globexCase, { email: COUNSEL })).status).toBe(201);

    const guest = await a.t.guestSignIn(COUNSEL);
    const { body } = await a.me(guest);
    if (!("guest" in body) || !body.guest) throw new Error("Not a Guest");
    expect(body.guest.cases.map((c) => `${c.organization.name} C-${c.number}`)).toEqual([
      `Globex C-${globexCase}`,
      `Acme Security C-${acmeCase}`,
    ]);
    // The most recent grant's Organization comes first.
    expect(body.guest.organization?.name).toBe("Globex");
    expect(await a.listNumbers(guest)).toEqual([globexCase]);
    expect((await a.view(guest, globexOther)).status).toBe(404);

    const acmeId = body.guest.cases.find((c) => c.organization.name === "Acme Security")!.organization.id;
    expect((await guest.api.me.organization.$put({ json: { organizationId: acmeId } })).status).toBe(200);
    expect(await a.listNumbers(guest)).toEqual([acmeCase]);
    const view = await a.view(guest, acmeCase);
    expect(view.body).toMatchObject({ case: { title: "Acme matter" } });

    const nowhere = await guest.api.me.organization.$put({ json: { organizationId: "not-an-organization" } });
    expect(nowhere.status).toBe(404);
    const memberSwitch = await a.owner.api.me.organization.$put({ json: { organizationId: acmeId } });
    expect(memberSwitch.status).toBe(403);
  });
});

describe("what Guests see and do", () => {
  test("Guests read their Case but change nothing, and never see the Audit Log", async () => {
    const a = await acme();
    const number = await a.open();
    await a.owner.api.cases[":number"].discussion.$post({ param: param(number), json: { body: "Contained at 10:02." } });
    await a.inviteCounsel(number);
    const guest = await a.t.guestSignIn(COUNSEL);

    const { body } = await a.view(guest, number);
    expect(body).toMatchObject({ case: { can: { work: false, restrict: false, reopen: false, manageGuests: false, readAuditLog: false } } });
    const messages = await (await guest.api.cases[":number"].discussion.$get({ param: param(number) })).json();
    expect(messages).toMatchObject({ messages: [{ body: "Contained at 10:02." }] });
    for (const read of [
      guest.api.cases[":number"].tasks.$get({ param: param(number) }),
      guest.api.cases[":number"].timeline.$get({ param: param(number) }),
      guest.api.cases[":number"].evidence.$get({ param: param(number) }),
      guest.api.cases[":number"].links.$get({ param: param(number) }),
      guest.api.cases.tags.$get(),
    ]) {
      expect((await read).status).toBe(200);
    }

    const refused = [
      guest.api.cases.$post({ json: { title: "Mine", caseType: "malware", severity: "low" } }),
      guest.api.cases[":number"].$patch({ param: param(number), json: { status: "triage" } }),
      guest.api.cases[":number"].discussion.$post({ param: param(number), json: { body: "Hello" } }),
      guest.api.cases[":number"].discussion.mentionable.$get({ param: param(number) }),
      guest.api.cases[":number"].guests.$get({ param: param(number) }),
      guest.api.cases[":number"].guests.$post({ param: param(number), json: { email: "friend@lawfirm.example" } }),
      guest.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} }),
    ];
    for (const res of refused) expect((await res).status).toBe(403);
    expect(await (await guest.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json()).toEqual({
      error: "Guests can't see the Audit Log",
    });
    // Member-only areas outside Cases.
    expect((await guest.api.organization.members.$get()).status as number).toBe(403);
  });

  test("Guests see Case Links only to other Cases they're invited to, and no cross-Case correlation", async () => {
    const a = await acme();
    const theirs = await a.open(a.owner, "Theirs");
    const alsoTheirs = await a.open(a.owner, "Also theirs");
    const notTheirs = await a.open(a.owner, "Not theirs");
    for (const target of [alsoTheirs, notTheirs]) {
      await a.owner.api.cases[":number"].links.$post({ param: param(theirs), json: { type: "related", case: target } });
    }
    for (const number of [theirs, notTheirs]) {
      await a.owner.api.cases[":number"].observables.$post({ param: param(number), json: { type: "domain", value: "evil.example" } });
    }
    await a.inviteCounsel(theirs);
    await a.inviteCounsel(alsoTheirs);
    const guest = await a.t.guestSignIn(COUNSEL);

    const links = await (await guest.api.cases[":number"].links.$get({ param: param(theirs) })).json();
    if (!("links" in links)) throw new Error("No links");
    expect(links.links.map((l) => l.case.number)).toEqual([alsoTheirs]);

    const items = await (await guest.api.cases[":number"].observables.$get({ param: param(theirs) })).json();
    expect(items).toMatchObject({ observables: [{ value: "evil.example", seenIn: [] }] });
    const asOwner = await (await a.owner.api.cases[":number"].observables.$get({ param: param(theirs) })).json();
    expect(asOwner).toMatchObject({ observables: [{ seenIn: [{ number: notTheirs }] }] });
  });

  test("a Guest viewing Evidence is recorded in the Audit Log as a Guest", async () => {
    const a = await acme();
    const number = await a.open();
    const res = await a.t.app.request(`http://argus.test/api/cases/${number}/evidence?name=memo.txt`, {
      method: "POST",
      headers: { cookie: a.owner.cookieHeader(), origin: "http://argus.test", "content-type": "text/plain" },
      body: "Notification memo",
    });
    const { evidence } = (await res.json()) as { evidence: { id: string } };
    await a.inviteCounsel(number);
    const guest = await a.t.guestSignIn(COUNSEL);
    const download = await guest.api.cases[":number"].evidence[":id"].download.$get({ param: { ...param(number), id: evidence.id } });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("Notification memo");
    const [entry] = await a.auditLog(a.owner, number);
    expect(entry).toMatchObject({ actor: { type: "guest", name: "Kim Patel" }, action: "evidence.downloaded", target: "memo.txt" });
  });
});

describe("when Guest access ends", () => {
  test("a grant stops counting when its expiry passes", async () => {
    const a = await acme();
    const lasting = await a.open(a.owner, "Lasting");
    const brief = await a.open(a.owner, "Brief");
    await a.inviteCounsel(lasting, new Date(a.t.clock.now().getTime() + 30 * HOUR).toISOString());
    await a.inviteCounsel(brief, new Date(a.t.clock.now().getTime() + 2 * HOUR).toISOString());
    const guest = await a.t.guestSignIn(COUNSEL);
    expect(await a.listNumbers(guest)).toEqual([brief, lasting]);

    a.t.clock.advance(2 * HOUR);
    expect(await a.listNumbers(guest)).toEqual([lasting]);
    expect((await a.view(guest, brief)).status).toBe(404);
    expect((await a.guestsOn(a.owner, brief))[0]).toMatchObject({ expired: true });

    a.t.clock.advance(28 * HOUR);
    const late = await a.t.guestSignIn(COUNSEL).catch((e: Error) => e);
    expect(late).toBeInstanceOf(Error);
    expect(await a.listNumbers(guest)).toBe(401);
  });

  test("access ends when every grant has expired, even mid-session", async () => {
    const a = await acme();
    const number = await a.open();
    await a.inviteCounsel(number, new Date(a.t.clock.now().getTime() + HOUR).toISOString());
    const guest = await a.t.guestSignIn(COUNSEL);
    a.t.clock.advance(HOUR);
    expect(await a.listNumbers(guest)).toBe(403);
    expect(await a.me(guest)).toMatchObject({ status: 200, body: { guest: { organization: null, cases: [] } } });
  });

  test("removing a Guest ends their access to that Case at once, and is recorded", async () => {
    const a = await acme();
    const first = await a.openForAna("First");
    const second = await a.open(a.owner, "Second");
    const grant = await a.inviteCounsel(first);
    await a.inviteCounsel(second);
    const guest = await a.t.guestSignIn(COUNSEL);

    expect((await a.remove(a.ben, first, grant)).status).toBe(403);
    const removed = await a.remove(a.ana, first, grant);
    expect(removed).toEqual({ status: 200, body: { guests: [] } });
    expect((await a.remove(a.ana, first, grant)).status).toBe(404);
    expect((await a.view(guest, first)).status).toBe(404);
    expect(await a.listNumbers(guest)).toEqual([second]);
    const [entry] = await a.auditLog(a.owner, first);
    expect(entry).toMatchObject({ actor: { type: "member", name: "Ana Analyst" }, action: "guest.removed", target: `Kim Patel <${COUNSEL}>` });
  });

  test("removed from their last Case, a Guest is signed out and gets no more links", async () => {
    const a = await acme();
    const open = await a.open(a.owner, "Open");
    const grant = await a.inviteCounsel(open);
    const guest = await a.t.guestSignIn(COUNSEL);
    await a.owner.api.cases[":number"].close.$post({ param: param(open), json: { resolution: "true_positive" } });
    // A Closed Case is read-only, but a Guest can still be removed from it.
    expect((await a.remove(a.owner, open, grant)).status).toBe(200);
    expect((await a.me(guest)).status).toBe(401);
    expect(await a.t.guestSignIn(COUNSEL).catch((e: Error) => e)).toBeInstanceOf(Error);
    // Invited again, they sign in again.
    const another = await a.open(a.owner, "Another");
    await a.inviteCounsel(another);
    expect(await a.listNumbers(await a.t.guestSignIn(COUNSEL))).toEqual([another]);
  });

  test("Guest grants are never deleted", async () => {
    const a = await acme();
    await a.inviteCounsel(await a.open());
    const error = await a.t.deps.db.execute(sql`delete from case_guests`).then(
      () => null,
      (e: { cause?: unknown }) => String(e.cause ?? e),
    );
    expect(error).toContain("case_guests rows cannot be deleted");
  });
});

describe("Guests live", () => {
  test("a Guest hears about their Case, is in its presence, and is disconnected when removed from their last Case", async () => {
    const a = await acme();
    const theirs = await a.open(a.owner, "Theirs");
    const notTheirs = await a.open(a.owner, "Not theirs");
    const grant = await a.inviteCounsel(theirs);
    const guest = await a.t.guestSignIn(COUNSEL);
    const live = await a.t.connect(guest);
    const ownerLive = await a.t.connect(a.owner);

    await a.owner.api.cases[":number"].$patch({ param: param(notTheirs), json: { severity: "critical" } });
    await a.owner.api.cases[":number"].$patch({ param: param(theirs), json: { severity: "critical" } });
    expect(await live.next()).toEqual({ type: "case", number: theirs });

    live.send({ type: "view", number: theirs });
    ownerLive.send({ type: "view", number: theirs });
    const presence = await ownerLive.next((m) => m.type === "presence" && m.viewers.length === 2);
    expect(presence).toMatchObject({ viewers: [{ name: "Kim Patel" }, { name: "Olive Owner" }] });

    await a.remove(a.owner, theirs, grant);
    expect(await live.closed).toEqual({ code: 4403, reason: "No longer a Guest on any Case here" });
  });
});
