import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { NotPermitted, organizationPolicy } from "../access/policy";
import { recordOrgAudit } from "../audit/org-audit-log";
import { caseRef, caseTypeLabel, type CaseType, type Severity, severityLabel } from "../cases/vocabulary";
import type { Tx } from "../db/client";
import { cases, teamsChannels, teamsPosts, user } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import type { TeamsMessage } from "./teams-webhook";
import type { TeamsPostKind } from "./vocabulary";

/**
 * The Organization's Teams channel. Admins set its incoming webhook (recorded in the Organization
 * Audit Log), send a test post to it, and remove it. While one is set, a new Critical Case, a Case
 * raised to Critical and a Case opened from Alerts are posted to it.
 *
 * Modules queue a post with `queueTeamsPost` in the transaction that makes the change; it is sent
 * once that commits (`sendTeamsPosts`), and the worker retries failures. Each post is written from
 * the Case as it is when sent, and a Restricted Case's says what happened and links to it, nothing more.
 */

export class InvalidTeamsWebhook extends Error {
  constructor(reason: string) {
    super(`Not a Teams webhook URL: ${reason}`);
  }
}

export class TeamsChannelNotSet extends Error {
  constructor() {
    super("No Teams channel webhook is set");
  }
}

export class TeamsPostFailed extends Error {}

/** Hosts Teams webhooks are served from: legacy connectors, and Workflows (Logic Apps and Power Platform). */
const TEAMS_HOSTS = [".webhook.office.com", ".logic.azure.com", ".api.powerplatform.com"];

/** Checks `url` is an HTTPS Teams webhook, so Argus never posts anywhere else. Throws `InvalidTeamsWebhook`. */
export function checkWebhookUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidTeamsWebhook("it isn't a URL");
  }
  if (parsed.protocol !== "https:") throw new InvalidTeamsWebhook("it must use https");
  if (parsed.username || parsed.password || parsed.port) throw new InvalidTeamsWebhook("it can't name a user or port");
  const host = parsed.hostname.toLowerCase();
  if (!TEAMS_HOSTS.some((suffix) => host.endsWith(suffix))) {
    throw new InvalidTeamsWebhook(`it must be on ${TEAMS_HOSTS.map((h) => `*${h}`).join(", ")}`);
  }
  return parsed.toString();
}

/** The webhook's host and last four characters: "acme.webhook.office.com/…a1b2". */
const hintOf = (url: string) => `${new URL(url).hostname}/…${url.slice(-4)}`;

/** A post is given up after this many failures. */
export const MAX_TEAMS_ATTEMPTS = 5;
/** The wait before the first retry, doubled after each failure. */
const RETRY_AFTER_MS = 30_000;
const BATCH = 50;

/** What to announce about a Case, from the module that changed it. */
export type TeamsAnnouncement = {
  organizationId: string;
  caseId: string;
  kind: TeamsPostKind;
  severity: Severity;
  /** How many Alerts the Case was opened from, when it was. */
  alertCount?: number;
  actorId: string;
};

/**
 * Queues a post to the Organization's Teams channel, in the transaction that makes the change.
 * Nothing is queued while no channel is set.
 */
export async function queueTeamsPost(tx: Tx, a: TeamsAnnouncement, now: Date) {
  const [channel] = await tx
    .select({ organizationId: teamsChannels.organizationId })
    .from(teamsChannels)
    .where(eq(teamsChannels.organizationId, a.organizationId));
  if (!channel) return;
  await tx.insert(teamsPosts).values({
    id: secureId(),
    organizationId: a.organizationId,
    caseId: a.caseId,
    kind: a.kind,
    severity: a.severity,
    alertCount: a.alertCount ?? null,
    actorId: a.actorId,
    createdAt: now,
    nextAttemptAt: now,
  });
}

/** What a Teams post is written from: the post, and the Case as it is now. */
export type PostFacts = {
  kind: TeamsPostKind;
  severity: Severity;
  alertCount: number | null;
  actorName: string;
  number: number;
  title: string;
  restricted: boolean;
  currentSeverity: Severity;
  caseType: CaseType;
  assigneeName: string | null;
};

const alerts = (n: number) => `${n} Alert${n === 1 ? "" : "s"}`;

/** The channel post for `p`, linking to the Case at `baseUrl`. A Restricted Case's names nothing but a link. */
export function teamsMessage(p: PostFacts, baseUrl: string): TeamsMessage {
  const critical = p.severity === "critical";
  const link = { title: "View Case", url: `${baseUrl}/cases/${p.number}` };
  if (p.restricted) {
    const heading =
      p.kind === "severity_critical"
        ? "A Restricted Case was raised to Critical"
        : critical
          ? "A Restricted Critical Case was opened"
          : "A Restricted Case was opened from Alerts";
    return { heading, facts: [], link };
  }
  const ref = caseRef(p.number);
  const heading =
    p.kind === "severity_critical"
      ? `${ref} raised to Critical`
      : `New ${critical ? "Critical " : ""}Case opened${p.alertCount ? ` from ${alerts(p.alertCount)}` : ""}`;
  return {
    heading,
    text: `${ref} · ${p.title}`,
    facts: [
      { title: "Severity", value: severityLabel[p.currentSeverity] },
      { title: "Case Type", value: caseTypeLabel[p.caseType] },
      { title: "Assignee", value: p.assigneeName ?? "Unassigned" },
      { title: p.kind === "severity_critical" ? "Raised by" : "Opened by", value: p.actorName },
    ],
    link,
  };
}

const actor = alias(user, "teams_post_actor");
const assignee = alias(user, "teams_post_assignee");

/**
 * Sends the queued Teams posts that are due, each by one process however many try at once. A
 * failure is retried with backoff, up to `MAX_TEAMS_ATTEMPTS`; posts for an Organization whose
 * channel was removed are dropped. Never throws.
 */
export async function sendTeamsPosts({ db, teams, credentials, clock, baseUrl }: Pick<Deps, "db" | "teams" | "credentials" | "clock" | "baseUrl">) {
  try {
    for (;;) {
      const handled = await db.transaction(async (tx) => {
        const now = clock.now();
        const due = await tx
          .select({ id: teamsPosts.id })
          .from(teamsPosts)
          .where(and(eq(teamsPosts.pending, true), lte(teamsPosts.nextAttemptAt, now)))
          .orderBy(asc(teamsPosts.seq))
          .limit(BATCH)
          .for("update", { skipLocked: true });
        if (!due.length) return 0;
        const rows = await tx
          .select({
            id: teamsPosts.id,
            organizationId: teamsPosts.organizationId,
            kind: teamsPosts.kind,
            severity: teamsPosts.severity,
            alertCount: teamsPosts.alertCount,
            attempts: teamsPosts.attempts,
            actorName: actor.name,
            number: cases.number,
            title: cases.title,
            restricted: cases.restricted,
            currentSeverity: cases.severity,
            caseType: cases.caseType,
            assigneeName: assignee.name,
            webhookUrl: teamsChannels.webhookUrl,
          })
          .from(teamsPosts)
          .innerJoin(cases, eq(teamsPosts.caseId, cases.id))
          .innerJoin(actor, eq(teamsPosts.actorId, actor.id))
          .leftJoin(assignee, eq(cases.assigneeId, assignee.id))
          .leftJoin(teamsChannels, eq(teamsPosts.organizationId, teamsChannels.organizationId))
          .where(inArray(teamsPosts.id, due.map((d) => d.id)))
          .orderBy(asc(teamsPosts.seq));
        for (const r of rows) {
          if (!r.webhookUrl) {
            await tx.update(teamsPosts).set({ pending: false, lastError: "The Teams channel was removed" }).where(eq(teamsPosts.id, r.id));
            continue;
          }
          try {
            await teams.post(await credentials.open(r.webhookUrl), teamsMessage(r, baseUrl));
            await tx.update(teamsPosts).set({ pending: false, sentAt: clock.now(), lastError: null }).where(eq(teamsPosts.id, r.id));
          } catch (e) {
            console.error("teams: post:", e);
            const attempts = r.attempts + 1;
            await tx
              .update(teamsPosts)
              .set({
                attempts,
                pending: attempts < MAX_TEAMS_ATTEMPTS,
                nextAttemptAt: new Date(now.getTime() + RETRY_AFTER_MS * 2 ** (attempts - 1)),
                lastError: e instanceof Error ? e.message : String(e),
              })
              .where(eq(teamsPosts.id, r.id));
          }
        }
        return rows.length;
      });
      if (handled < BATCH) return;
    }
  } catch (e) {
    console.error("teams: post:", e);
  }
}

/** The worker's part: Teams posts not sent yet, and retries. Call `tick` regularly. */
export function createTeamsSender(deps: Pick<Deps, "db" | "teams" | "credentials" | "clock" | "baseUrl">) {
  return { tick: () => sendTeamsPosts(deps) };
}

const actorOf = (me: Membership) => ({ type: "member" as const, id: me.userId, name: me.name });

const TEST_MESSAGE = (me: Membership, baseUrl: string): TeamsMessage => ({
  heading: "Argus is connected to this channel",
  text: `${me.name} sent this test post from ${me.organizationName}. New Critical Cases, Cases raised to Critical and Cases opened from Alerts will be posted here.`,
  facts: [],
  link: { title: "Open Argus", url: baseUrl },
});

export function teamsChannelStore({ db, clock, credentials, teams, baseUrl }: Pick<Deps, "db" | "clock" | "credentials" | "teams" | "baseUrl">) {
  const post = async (url: string, message: TeamsMessage) => {
    try {
      await teams.post(url, message);
    } catch (e) {
      throw new TeamsPostFailed(`Teams didn't accept the post: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    /** Whether a channel is set; for Admins, which webhook (by its hint), who set it and when. */
    async get(me: Membership) {
      const [row] = await db
        .select({ urlHint: teamsChannels.urlHint, updatedAt: teamsChannels.updatedAt, byId: user.id, byName: user.name })
        .from(teamsChannels)
        .innerJoin(user, eq(teamsChannels.updatedById, user.id))
        .where(eq(teamsChannels.organizationId, me.organizationId));
      if (!row) return { configured: false as const, webhook: null };
      const admin = organizationPolicy.canManageTeamsChannel(me);
      return {
        configured: true as const,
        webhook: admin ? { hint: row.urlHint, updatedBy: { id: row.byId, name: row.byName }, updatedAt: row.updatedAt.toISOString() } : null,
      };
    },

    /** Sets (or replaces) the channel's webhook. Admins only. Throws `InvalidTeamsWebhook`. */
    async set(me: Membership, webhookUrl: string) {
      if (!organizationPolicy.canManageTeamsChannel(me)) throw new NotPermitted();
      const url = checkWebhookUrl(webhookUrl);
      const sealed = await credentials.seal(url);
      const now = clock.now();
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ urlHint: teamsChannels.urlHint })
          .from(teamsChannels)
          .where(eq(teamsChannels.organizationId, me.organizationId))
          .for("update");
        const values = { webhookUrl: sealed, urlHint: hintOf(url), updatedById: me.userId, updatedAt: now };
        await tx
          .insert(teamsChannels)
          .values({ organizationId: me.organizationId, ...values })
          .onConflictDoUpdate({ target: teamsChannels.organizationId, set: values });
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: now,
          actor: actorOf(me),
          category: "teams",
          action: current ? "teams.webhook_changed" : "teams.webhook_set",
          target: "Teams channel",
          before: current?.urlHint ?? null,
          after: hintOf(url),
        });
      });
    },

    /** Removes the channel's webhook; posts not yet sent are dropped. Admins only. Throws `TeamsChannelNotSet`. */
    async remove(me: Membership) {
      if (!organizationPolicy.canManageTeamsChannel(me)) throw new NotPermitted();
      await db.transaction(async (tx) => {
        const [removed] = await tx
          .delete(teamsChannels)
          .where(eq(teamsChannels.organizationId, me.organizationId))
          .returning({ urlHint: teamsChannels.urlHint });
        if (!removed) throw new TeamsChannelNotSet();
        await tx
          .update(teamsPosts)
          .set({ pending: false, lastError: "The Teams channel was removed" })
          .where(and(eq(teamsPosts.organizationId, me.organizationId), eq(teamsPosts.pending, true)));
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: clock.now(),
          actor: actorOf(me),
          category: "teams",
          action: "teams.webhook_removed",
          target: "Teams channel",
          before: removed.urlHint,
        });
      });
    },

    /**
     * Sends a test post to `webhookUrl`, or to the channel set when none is given, and waits for
     * Teams to accept it. Admins only. Throws `InvalidTeamsWebhook`, `TeamsChannelNotSet` or `TeamsPostFailed`.
     */
    async test(me: Membership, webhookUrl?: string) {
      if (!organizationPolicy.canManageTeamsChannel(me)) throw new NotPermitted();
      let url: string;
      if (webhookUrl !== undefined) url = checkWebhookUrl(webhookUrl);
      else {
        const [row] = await db
          .select({ webhookUrl: teamsChannels.webhookUrl })
          .from(teamsChannels)
          .where(eq(teamsChannels.organizationId, me.organizationId));
        if (!row) throw new TeamsChannelNotSet();
        url = await credentials.open(row.webhookUrl);
      }
      await post(url, TEST_MESSAGE(me, baseUrl));
    },
  };
}

export type TeamsChannelStore = ReturnType<typeof teamsChannelStore>;
