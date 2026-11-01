import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { GuestActor } from "../access/policy";
import type { OrgRole } from "../auth/roles";
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import { member, organization } from "../db/schema";
import type { Env } from "../deps";
import { guestCasesOf } from "../guests/grants";

/** The signed-in person's place in their Organization. */
export type Membership = {
  memberId: string;
  organizationId: string;
  organizationName: string;
  role: OrgRole;
  userId: string;
  name: string;
};

/** A signed-in Guest, acting in one of the Organizations that granted them Cases. */
export type GuestPass = GuestActor & { organizationName: string; name: string };

/** Whoever is working on Cases: a Member, or a Guest. */
export type Participant = Membership | GuestPass;

export type MemberEnv = { Variables: Env["Variables"] & { membership: Membership } };
export type ParticipantEnv = { Variables: Env["Variables"] & { participant: Participant } };
/** A route on Cases that only Members may use. */
export type CaseWorkEnv = { Variables: ParticipantEnv["Variables"] & { membership: Membership } };

/** The one Organization `userId` is a Member of, unless it has been deleted. */
export async function findMembership(db: Db, userId: string) {
  const [row] = await db
    .select({
      memberId: member.id,
      organizationId: organization.id,
      organizationName: organization.name,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(and(eq(member.userId, userId), isNull(organization.deletedAt)))
    .limit(1);
  return row ? { ...row, role: row.role as OrgRole } : null;
}

/**
 * The Guest's pass at `at`: in the Organization they chose (`preferred`) if they still hold a grant
 * there, else the one that granted them a Case most recently. Null once no grant of theirs counts.
 */
export async function findGuestPass(db: Db, who: { userId: string; name: string }, preferred: string | null, at: Date) {
  const granted = await guestCasesOf(db, who.userId, at);
  const chosen = granted.find((c) => c.organization.id === preferred) ?? granted[0];
  if (!chosen) return null;
  return {
    role: "guest",
    organizationId: chosen.organization.id,
    organizationName: chosen.organization.name,
    userId: who.userId,
    name: who.name,
    at,
  } satisfies GuestPass;
}

/** Lets through signed-in Members and sets `membership`. What each may do is up to the modules. */
export const requireMember = (db: Db) =>
  createMiddleware<MemberEnv>(async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Not signed in" }, 401);
    const found = await findMembership(db, user.id);
    if (!found) return c.json({ error: "Not a Member of an Organization" }, 403);
    const membership = { ...found, userId: user.id, name: user.name };
    c.set("membership", membership);
    await next();
  });

/**
 * Lets through signed-in Members, and Guests while a grant of theirs counts, and sets `participant`.
 * What each may see and do is up to the modules.
 */
export const requireParticipant = ({ db, clock }: { db: Db; clock: Clock }) =>
  createMiddleware<ParticipantEnv>(async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Not signed in" }, 401);
    const found = await findMembership(db, user.id);
    if (found) {
      c.set("participant", { ...found, userId: user.id, name: user.name });
      return next();
    }
    const guest = c.get("guestSession");
    const pass = guest && (await findGuestPass(db, { userId: user.id, name: user.name }, guest.organizationId, clock.now()));
    if (!pass) return c.json({ error: "You don't have access to any Cases" }, 403);
    c.set("participant", pass);
    await next();
  });

/** For a route behind `requireParticipant` that Guests may not use: sets `membership`. */
export const membersOnly = createMiddleware<CaseWorkEnv>(async (c, next) => {
  const participant = c.get("participant");
  if (participant.role === "guest") return c.json({ error: "Guests can't do this" }, 403);
  c.set("membership", participant);
  await next();
});
