import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { casePolicy, countingGrants, NotPermitted } from "../access/policy";
import { OPERATOR_ROLE } from "../auth/roles";
import { signOutEverywhere } from "../auth/sessions";
import { actorOf, lockCase } from "../cases/cases";
import { recordCaseAudit } from "../cases/case-audit-log";
import type { Db, Tx } from "../db/client";
import { caseGuests, cases, member, user } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import { publish } from "../realtime/signals";
import { sendGuestInvite } from "./invite-email";

/**
 * Guests on a Case: inviting them by email, listing them and removing them. A Guest is an Argus
 * account that belongs to no Organization; a Guest grant lets it into one Case, optionally until a
 * set time. Only Admins, the Owner and the Case's Assignee invite and remove Guests.
 */

/** The email belongs to a Member or an Operator, who can't be a Guest. */
export class NotAGuest extends Error {
  constructor() {
    super("This email belongs to a Member; Members can't be invited as Guests");
  }
}
/** The person already holds a Guest grant on this Case. */
export class AlreadyGuest extends Error {
  constructor() {
    super("They are already a Guest on this Case");
  }
}
/** No current Guest grant with this id on the Case. */
export class GuestNotFound extends Error {
  constructor() {
    super("Guest not found");
  }
}
/** An expiry has to be in the future. */
export class ExpiryPassed extends Error {
  constructor() {
    super("The access expiry must be in the future");
  }
}

export type GuestInvite = { email: string; name?: string; expiresAt: Date | null };

const invitedBy = alias(user, "invited_by");

/** The Case's current Guest grants (expired ones included, marked so), oldest first. */
async function guestsOf(db: Db | Tx, caseId: string, now: Date) {
  const rows = await db
    .select({
      id: caseGuests.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      expiresAt: caseGuests.expiresAt,
      invitedById: invitedBy.id,
      invitedByName: invitedBy.name,
      invitedAt: caseGuests.invitedAt,
    })
    .from(caseGuests)
    .innerJoin(user, eq(caseGuests.userId, user.id))
    .innerJoin(invitedBy, eq(caseGuests.invitedById, invitedBy.id))
    .where(and(eq(caseGuests.caseId, caseId), isNull(caseGuests.endedAt)))
    .orderBy(asc(caseGuests.invitedAt), asc(caseGuests.seq));
  return rows.map((r) => ({
    id: r.id,
    guest: { id: r.userId, name: r.name, email: r.email },
    expiresAt: r.expiresAt?.toISOString() ?? null,
    expired: r.expiresAt !== null && r.expiresAt <= now,
    invitedBy: { id: r.invitedById, name: r.invitedByName },
    invitedAt: r.invitedAt.toISOString(),
  }));
}

export type GuestGrantView = Awaited<ReturnType<typeof guestsOf>>[number];

/** "Kim Patel <k.patel@lawfirm.example>": how the Audit Log names a Guest. */
const describeGuest = (g: { name: string; email: string }) => `${g.name} <${g.email}>`;
const describeExpiry = (expiresAt: Date | null) => (expiresAt ? `until ${expiresAt.toISOString()}` : "no expiry");

export function guestStore(deps: Pick<Deps, "db" | "auth" | "clock" | "mailer" | "baseUrl">) {
  const { db, auth, clock } = deps;

  /** The account for `email`, made as a Guest's if there's none yet; `NotAGuest` if it's a Member's or an Operator's. */
  const guestAccount = async (email: string, name: string | undefined) => {
    const existing = await db.query.user.findFirst({ where: eq(user.email, email) });
    if (existing) {
      const [membership] = await db.select({ id: member.id }).from(member).where(eq(member.userId, existing.id)).limit(1);
      if (membership || existing.role === OPERATOR_ROLE) throw new NotAGuest();
      return existing;
    }
    // Server-side call: no session, so Better Auth treats it as trusted. No password: Guests use magic links.
    const { user: created } = await auth.api.createUser({
      body: { email, name: name?.trim() || email.split("@")[0]!, role: "user" },
    });
    return created;
  };

  return {
    /** The Case's Guests. Members who can see the Case only. */
    async list(me: Membership, number: number) {
      const now = clock.now();
      return db.transaction(async (tx) => guestsOf(tx, (await lockCase(tx, me, number, "allow")).id, now));
    },

    /**
     * Invites `email` to the Case as a Guest, making their account if they have none, and emails
     * them how to sign in. Admins, the Owner and the Assignee only; not on a Closed Case.
     */
    async invite(me: Membership, number: number, input: GuestInvite) {
      const now = clock.now();
      const email = input.email.trim().toLowerCase();
      if (input.expiresAt && input.expiresAt <= now) throw new ExpiryPassed();
      // Refuse before making an account for someone who can't be invited here.
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        if (!casePolicy.canManageGuests(me, current)) throw new NotPermitted();
      });
      const account = await guestAccount(email, input.name);
      const { title, guests } = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        if (!casePolicy.canManageGuests(me, current)) throw new NotPermitted();
        if (current.guests.some((g) => g.userId === account.id)) throw new AlreadyGuest();
        await tx.insert(caseGuests).values({
          id: secureId(),
          organizationId: me.organizationId,
          caseId: current.id,
          userId: account.id,
          expiresAt: input.expiresAt,
          invitedById: me.userId,
          invitedAt: now,
        });
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "guest.invited",
          target: describeGuest(account),
          after: describeExpiry(input.expiresAt),
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id });
        const [row] = (await tx.select({ title: cases.title }).from(cases).where(eq(cases.id, current.id))) as [{ title: string }];
        return { title: row.title, guests: await guestsOf(tx, current.id, now) };
      });
      await sendGuestInvite(deps, {
        email,
        organizationName: me.organizationName,
        number,
        title,
        invitedBy: me.name,
        expiresAt: input.expiresAt,
      });
      return guests;
    },

    /**
     * Ends a Guest's grant on the Case, at once. Removed from their last Case, they are signed out
     * everywhere. Admins, the Owner and the Assignee only; allowed on a Closed Case.
     */
    async remove(me: Membership, number: number, grantId: string) {
      const now = clock.now();
      return db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number, "allow");
        if (!casePolicy.canManageGuests(me, current)) throw new NotPermitted();
        const [grant] = await tx
          .select({ id: caseGuests.id, userId: user.id, name: user.name, email: user.email })
          .from(caseGuests)
          .innerJoin(user, eq(caseGuests.userId, user.id))
          .where(and(eq(caseGuests.id, grantId), eq(caseGuests.caseId, current.id), isNull(caseGuests.endedAt)))
          .for("update", { of: caseGuests });
        if (!grant) throw new GuestNotFound();
        await tx.update(caseGuests).set({ endedAt: now, endedById: me.userId }).where(eq(caseGuests.id, grant.id));
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "guest.removed",
          target: describeGuest(grant),
        });
        const [remaining] = await tx.select({ id: caseGuests.id }).from(caseGuests).where(countingGrants(grant.userId, now)).limit(1);
        if (!remaining) await signOutEverywhere(tx, [grant.userId]);
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id, before: { guests: current.guests } });
        return guestsOf(tx, current.id, now);
      });
    },
  };
}

export type GuestStore = ReturnType<typeof guestStore>;
