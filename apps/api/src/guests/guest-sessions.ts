import { and, eq } from "drizzle-orm";
import { OPERATOR_ROLE } from "../auth/roles";
import type { Db } from "../db/client";
import { guestSessions, member, session, user } from "../db/schema";
import { guestCasesOf } from "./grants";

/**
 * Guests' sessions. A Guest signs in with a magic link and works for about 12 hours before signing
 * in again. Argus times that itself, by its own clock, from the first request the session makes;
 * Better Auth's own session expiry is longer and only a backstop.
 */

/** How long a Guest's session lasts. */
export const GUEST_SESSION_MS = 12 * 60 * 60 * 1000;

/** A Guest's session as Argus judges it. `organizationId`: the Organization they chose to work in, if any. */
export type GuestSession = { sessionId: string; expiresAt: Date; organizationId: string | null };

/** Whether the account is a Guest's: not an Operator, and not a Member of any Organization. */
export async function isGuestAccount(db: Db, account: { id: string; role?: string | null }) {
  if (account.role === OPERATOR_ROLE) return false;
  const [membership] = await db.select({ id: member.id }).from(member).where(eq(member.userId, account.id)).limit(1);
  return !membership;
}

/** Whether the person with this email may get a magic link: a Guest holding a grant that counts at `at`. */
export async function mayUseMagicLink(db: Db, email: string, at: Date) {
  const [account] = await db.select({ id: user.id, role: user.role }).from(user).where(eq(user.email, email.toLowerCase())).limit(1);
  if (!account || !(await isGuestAccount(db, account))) return false;
  return (await guestCasesOf(db, account.id, at)).length > 0;
}

/** Starts the clock on a Guest's new session at `now`. Better Auth calls it as it creates the session. */
export async function startGuestSession(db: Db, now: Date, { sessionId, userId }: { sessionId: string; userId: string }) {
  await db
    .insert(guestSessions)
    .values({ sessionId, userId, expiresAt: new Date(now.getTime() + GUEST_SESSION_MS) })
    .onConflictDoNothing();
}

/**
 * The Guest session behind Better Auth session `sessionId`, starting its clock at `now` if it wasn't
 * (a session made before Argus timed them). Once it has run out, the session is signed out and this
 * returns null.
 */
export async function guestSession(db: Db, now: Date, { sessionId, userId }: { sessionId: string; userId: string }) {
  await startGuestSession(db, now, { sessionId, userId });
  const [row] = await db.select().from(guestSessions).where(eq(guestSessions.sessionId, sessionId)).limit(1);
  if (!row) return null;
  if (row.expiresAt <= now) {
    await db.delete(session).where(eq(session.id, sessionId));
    return null;
  }
  return { sessionId, expiresAt: row.expiresAt, organizationId: row.organizationId } satisfies GuestSession;
}

/**
 * Makes `organizationId` the Organization the Guest works in for the rest of this session. Returns
 * false, changing nothing, unless they hold a grant there that counts at `at`.
 */
export async function chooseOrganization(db: Db, at: Date, who: { sessionId: string; userId: string }, organizationId: string) {
  const granted = await guestCasesOf(db, who.userId, at);
  if (!granted.some((c) => c.organization.id === organizationId)) return false;
  await db
    .update(guestSessions)
    .set({ organizationId })
    .where(and(eq(guestSessions.sessionId, who.sessionId), eq(guestSessions.userId, who.userId)));
  return true;
}
