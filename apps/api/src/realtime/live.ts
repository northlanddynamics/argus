import { and, asc, eq, inArray, isNull, lt, gte } from "drizzle-orm";
import { z } from "zod";
import { type Actor, type CaseAccessFacts, canSeeCase, visibleCases } from "../access/policy";
import type { OrgRole } from "../auth/roles";
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import { caseRoleHolderIds } from "../case-roles/holders";
import { guestCasesOf, guestGrantsOf } from "../guests/grants";
import { cases, caseViewers, member, organization, user } from "../db/schema";
import { secureId } from "../ids";
import type { ClientMessage, ServerMessage, Viewer } from "./messages";
import { publish, type Signal, type SignalSource } from "./signals";

/**
 * The live hub of one `web` process: its Members' and Guests' sockets, and the signals forwarded to them.
 *
 * Every signal, local or not, arrives through Postgres (`signals.ts`) and is forwarded only to
 * sockets whose person can see the Case, as the access policy decides it at that moment. A Guest's
 * socket belongs to the Organization they were working in when they opened it.
 * Signals are handled one at a time, in commit order.
 *
 * Presence lives in `case_viewers`, shared by all processes. Each process refreshes its own rows
 * every `PRESENCE_HEARTBEAT_MS` (`sweep`); rows older than `PRESENCE_TIMEOUT_MS` belonged to a
 * process that died, and are removed.
 */

export const PRESENCE_HEARTBEAT_MS = 20_000;
export const PRESENCE_TIMEOUT_MS = 60_000;

/** Close codes the client tells apart from a dropped connection. */
export const CLOSE_NOT_A_MEMBER = 4403;

/** What the hub needs from a socket. */
export type Transport = { send(data: string): void; close(code: number, reason: string): void };

/**
 * The person a socket belongs to, kept current as their role changes. A Guest's socket closes when
 * their session ends (`until`).
 */
export type SocketMember = Actor & { name: string; until?: Date };

type Socket = {
  id: string;
  member: SocketMember;
  transport: Transport;
  /** The Case page the socket is on, once the Member is known to see it. */
  viewing: { caseId: string; number: number } | null;
};

const clientMessage = z.object({ type: z.literal("view"), number: z.number().int().positive().nullable() });

export function createLive({ db, clock, signals }: { db: Db; clock: Clock; signals: SignalSource }) {
  const sockets = new Map<string, Socket>();

  let queue = Promise.resolve();
  /** Runs `work` after everything queued before it, so signals and socket events apply in order. */
  const enqueue = (work: () => Promise<void>) => {
    const next = queue.then(work).catch((e: unknown) => console.error("live:", e));
    queue = next;
    return next;
  };

  const send = (s: Socket, message: ServerMessage) => s.transport.send(JSON.stringify(message));
  const inOrganization = (organizationId: string) =>
    [...sockets.values()].filter((s) => s.member.organizationId === organizationId);

  const accessFacts = async (caseId: string) => {
    const [row] = await db
      .select({ number: cases.number, organizationId: cases.organizationId, restricted: cases.restricted, assigneeId: cases.assigneeId })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1);
    return row ? { ...row, caseRoleHolderIds: await caseRoleHolderIds(db, caseId), guests: await guestGrantsOf(db, caseId) } : null;
  };

  /** Who is viewing the Case, once each, by name. */
  const viewersOf = async (caseId: string): Promise<Viewer[]> =>
    db
      .selectDistinct({ id: user.id, name: user.name })
      .from(caseViewers)
      .innerJoin(user, eq(caseViewers.userId, user.id))
      .where(and(eq(caseViewers.caseId, caseId), gte(caseViewers.seenAt, new Date(clock.now().getTime() - PRESENCE_TIMEOUT_MS))))
      .orderBy(asc(user.name), asc(user.id));

  const stopViewing = async (s: Socket) => {
    if (!s.viewing) return;
    const { caseId } = s.viewing;
    s.viewing = null;
    await db.delete(caseViewers).where(eq(caseViewers.socketId, s.id));
    await publish(db, { kind: "presence", organizationId: s.member.organizationId, caseId });
  };

  const view = async (s: Socket, number: number | null) => {
    if (s.viewing?.number === number) return;
    await stopViewing(s);
    if (number === null) return;
    if (s.member.role === "guest") s.member = { ...s.member, at: clock.now() };
    const [found] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(visibleCases(s.member), eq(cases.number, number)))
      .limit(1);
    // A Case they can't see is ignored, as if it didn't exist.
    if (!found || !sockets.has(s.id)) return;
    s.viewing = { caseId: found.id, number };
    await db.insert(caseViewers).values({
      socketId: s.id,
      organizationId: s.member.organizationId,
      caseId: found.id,
      userId: s.member.userId,
      seenAt: clock.now(),
    });
    await publish(db, { kind: "presence", organizationId: s.member.organizationId, caseId: found.id });
  };

  /**
   * Re-reads the Members behind `local` sockets: closes those who are no longer Members and updates
   * roles. Guests' sockets close once their session has ended or no grant of theirs in the
   * Organization counts. Returns the sockets still open, and those whose role changed.
   */
  const refreshMembers = async (organizationId: string, inOrg: Socket[]) => {
    const now = clock.now();
    const open: Socket[] = [];
    const roleChanged: Socket[] = [];
    const local: Socket[] = [];
    for (const s of inOrg) {
      if (s.member.role !== "guest") {
        local.push(s);
        continue;
      }
      const granted = s.member.until && s.member.until > now ? await guestCasesOf(db, s.member.userId, now) : [];
      if (!granted.some((c) => c.organization.id === organizationId)) {
        await disconnect(s);
        s.transport.close(CLOSE_NOT_A_MEMBER, "No longer a Guest on any Case here");
        continue;
      }
      s.member = { ...s.member, at: now };
      open.push(s);
    }
    if (!local.length) return { open, roleChanged };
    const rows = await db
      .select({ userId: member.userId, role: member.role })
      .from(member)
      .innerJoin(organization, eq(member.organizationId, organization.id))
      .where(
        and(
          eq(member.organizationId, organizationId),
          isNull(organization.deletedAt),
          inArray(member.userId, [...new Set(local.map((s) => s.member.userId))]),
        ),
      );
    const roles = new Map(rows.map((r) => [r.userId, r.role as OrgRole]));
    for (const s of local) {
      const role = roles.get(s.member.userId);
      if (!role) {
        await disconnect(s);
        s.transport.close(CLOSE_NOT_A_MEMBER, "No longer a Member of the Organization");
        continue;
      }
      if (role !== s.member.role) {
        s.member = { ...s.member, role };
        roleChanged.push(s);
      }
      open.push(s);
    }
    return { open, roleChanged };
  };

  /** Drops the presence of sockets on Case `caseId` whose Member can no longer see it. */
  const dropUnseen = async (local: Socket[], caseId: string, facts: CaseAccessFacts) => {
    for (const s of local) if (s.viewing?.caseId === caseId && !canSeeCase(s.member, facts)) await stopViewing(s);
  };

  const deliver = async (signal: Signal) => {
    const local = inOrganization(signal.organizationId);
    if (!local.length) return;
    const { open, roleChanged } = await refreshMembers(signal.organizationId, local);

    if (signal.kind === "members") {
      // What they can see may have changed with their role: refresh their screens.
      for (const s of roleChanged) send(s, { type: "resync" });
      const viewed = new Set(open.flatMap((s) => (s.viewing ? [s.viewing.caseId] : [])));
      for (const caseId of viewed) {
        const facts = await accessFacts(caseId);
        if (facts) await dropUnseen(open, caseId, facts);
      }
      return;
    }

    if (signal.kind === "alerts") {
      // Guests never see Alerts or Integrations.
      for (const s of open) if (s.member.role !== "guest") send(s, { type: "alerts" });
      return;
    }

    const facts = await accessFacts(signal.caseId);
    if (!facts) return;

    if (signal.kind === "case") {
      const before = signal.before && { ...facts, ...signal.before };
      for (const s of open) {
        if (canSeeCase(s.member, facts) || (before && canSeeCase(s.member, before))) send(s, { type: "case", number: facts.number });
      }
      await dropUnseen(open, signal.caseId, facts);
      return;
    }

    const watching = open.filter((s) => s.viewing?.caseId === signal.caseId && canSeeCase(s.member, facts));
    if (!watching.length) return;
    const viewers = await viewersOf(signal.caseId);
    for (const s of watching) send(s, { type: "presence", number: facts.number, viewers });
  };

  const disconnect = async (s: Socket) => {
    if (!sockets.delete(s.id)) return;
    await stopViewing(s);
  };

  const listening = signals.listen(
    (signal) => void enqueue(() => deliver(signal)),
    // Signals were lost while the connection was down: every socket refetches.
    () => void enqueue(async () => sockets.forEach((s) => send(s, { type: "resync" }))),
  );

  return {
    /** Resolves once this process hears signals. */
    ready: listening.then(() => undefined),

    /** Registers a newly opened socket for `member`. */
    connect(who: SocketMember, transport: Transport) {
      const s: Socket = { id: secureId(), member: who, transport, viewing: null };
      sockets.set(s.id, s);
      return {
        receive(data: string) {
          let message: ClientMessage;
          try {
            message = clientMessage.parse(JSON.parse(data));
          } catch {
            return;
          }
          void enqueue(async () => {
            if (sockets.has(s.id)) await view(s, message.number);
          });
        },
        closed() {
          void enqueue(() => disconnect(s));
        },
      };
    },

    /**
     * The presence heartbeat: refreshes this process's viewers and removes viewers no process has
     * refreshed within the timeout. Run every `PRESENCE_HEARTBEAT_MS`.
     */
    sweep() {
      return enqueue(async () => {
        const now = clock.now();
        const mine = [...sockets.values()].filter((s) => s.viewing).map((s) => s.id);
        if (mine.length) await db.update(caseViewers).set({ seenAt: now }).where(inArray(caseViewers.socketId, mine));
        const expired = await db
          .delete(caseViewers)
          .where(lt(caseViewers.seenAt, new Date(now.getTime() - PRESENCE_TIMEOUT_MS)))
          .returning({ organizationId: caseViewers.organizationId, caseId: caseViewers.caseId });
        const seen = new Set<string>();
        for (const { organizationId, caseId } of expired) {
          if (seen.has(caseId)) continue;
          seen.add(caseId);
          await publish(db, { kind: "presence", organizationId, caseId });
        }
      });
    },

    /** Waits until every signal and socket event received so far has been handled. */
    settled: () => queue,

    /** Stops listening and removes this process's viewers, telling the other processes. */
    async close() {
      const { stop } = await listening;
      await stop();
      await enqueue(async () => {
        for (const s of sockets.values()) await disconnect(s);
      });
    },
  };
}

export type Live = ReturnType<typeof createLive>;
