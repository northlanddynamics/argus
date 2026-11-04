import { and, desc, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { isGuest, visibleCases, visibleItems } from "../access/policy";
import type { AlertStatus } from "../alerts/vocabulary";
import type { Severity, Status } from "../cases/vocabulary";
import type { Db } from "../db/client";
import { alertAssets, alertObservables, alerts, assets, caseAssets, caseObservables, cases, integrations, observables } from "../db/schema";
import type { Participant } from "../members/membership";
import type { AssetType, ObservableType } from "../observables/vocabulary";
import { SEARCH_DEFAULT_LIMIT, SEARCH_KINDS, type SearchKind } from "./vocabulary";

/**
 * Global search: Cases (by title and Case Summary), Alerts (by title, Falcon's id, host, user and
 * description), Observables and Assets (by value), with Postgres full-text search over the `search`
 * columns (`db/argus-schema.ts`). The query is read as a web search: words, "quoted phrases", `or`
 * and `-excluded`. Each word also matches as the start of a longer one, so results come as the query
 * is typed ("invo" finds invoice-portal.biz); whole-word matches rank higher.
 *
 * Results go through the access policy like every other read:
 * - Cases: those `visibleCases` lets the actor see, so Restricted Cases never leak.
 * - Alerts: Members search the whole Alert queue, and are shown the Case an Alert is on only if they
 *   can see it. Guests find only Alerts attached to their Cases that aren't Internal.
 * - Observables and Assets: those linked to a Case the actor can see and, for Members, those an
 *   Alert names. Each lists the Cases it is linked to among those the actor can see.
 *
 * Typing a Case's reference ("C-12", or "12") finds that Case first, if the actor can see it.
 */

type CaseRef = { number: number; title: string };

/** How well a result matches, comparable across kinds: higher is better. */
type Ranked = { rank: number };

type ItemResult<Type extends string> = Ranked & {
  id: string;
  type: Type;
  value: string;
  /** The Cases it is linked to that the actor can see, newest first. */
  cases: CaseRef[];
};

export type SearchResults = {
  cases: (Ranked & { number: number; title: string; status: Status; severity: Severity; restricted: boolean })[];
  alerts: (Ranked & {
    id: string;
    externalId: string;
    title: string;
    severity: Severity;
    status: AlertStatus;
    host: string | null;
    userName: string | null;
    integration: { name: string };
    receivedAt: string;
    /** The Case it is attached to, unless that is a Case the actor can't see. */
    case: CaseRef | null;
  })[];
  observables: ItemResult<ObservableType>[];
  assets: ItemResult<AssetType>[];
  /** For each kind, whether there are more results than were returned. */
  more: Record<SearchKind, boolean>;
};

export type SearchOptions = {
  /** Which kinds to search; all of them when empty or left out. */
  kinds?: readonly SearchKind[];
  /** At most this many of each kind. */
  limit?: number;
};

const empty = (): SearchResults => ({
  cases: [],
  alerts: [],
  observables: [],
  assets: [],
  more: { cases: false, alerts: false, observables: false, assets: false },
});

/** The Case number a query names, as in "C-12", "c12", "#12" or "12"; else null. */
const caseNumberIn = (query: string) => {
  const match = /^#?(?:c-?)?(\d{1,9})$/i.exec(query.trim());
  return match ? Number(match[1]) : null;
};

/** A Case named by its reference ranks above any text match. */
const REFERENCE_RANK = 1000;

/** Keeps the first `limit` rows and says whether there were more. */
const page = <T>(rows: T[], limit: number) => ({ rows: rows.slice(0, limit), more: rows.length > limit });

export function searchStore({ db }: { db: Db }) {
  const observableKind = { items: observables, links: caseObservables, alertLinks: alertObservables };
  const assetKind = { items: assets, links: caseAssets, alertLinks: alertAssets };
  type Query = { matches: (column: SQL | AnyColumn) => SQL; rank: (column: AnyColumn) => SQL<number> };

  async function searchItems(me: Participant, q: Query, kind: typeof observableKind, limit: number) {
    const { items, links, alertLinks } = kind;
    const onVisibleCase = exists(
      db
        .select({ one: sql`1` })
        .from(links)
        .innerJoin(cases, eq(links.caseId, cases.id))
        .where(and(eq(links.itemId, items.id), isNull(links.unlinkedAt), visibleCases(me))),
    );
    // Members see every Alert, so they see what each one names too.
    const namedByAlert = isGuest(me)
      ? undefined
      : exists(db.select({ one: sql`1` }).from(alertLinks).where(eq(alertLinks.itemId, items.id)));
    const { rows, more } = page(
      await db
        .select({ id: items.id, type: items.type, value: items.value, rank: q.rank(items.search) })
        .from(items)
        .where(and(eq(items.organizationId, me.organizationId), q.matches(items.search), or(onVisibleCase, namedByAlert)))
        .orderBy(desc(q.rank(items.search)), items.value)
        .limit(limit + 1),
      limit,
    );
    if (!rows.length) return { rows: [], more };
    const linked = await db
      .select({ itemId: links.itemId, number: cases.number, title: cases.title })
      .from(links)
      .innerJoin(cases, eq(links.caseId, cases.id))
      .where(
        and(
          inArray(
            links.itemId,
            rows.map((r) => r.id),
          ),
          isNull(links.unlinkedAt),
          visibleCases(me),
        ),
      )
      .orderBy(desc(cases.number));
    return {
      rows: rows.map((r) => ({
        ...r,
        cases: linked.filter((l) => l.itemId === r.id).map(({ number, title }) => ({ number, title })),
      })),
      more,
    };
  }

  /**
   * The query as a tsquery, and the same with every word also matching as a prefix; null when it
   * holds no words to look for (only punctuation, or only excluded words' operators).
   */
  async function parse(text: string): Promise<{ exact: string; prefix: string } | null> {
    const [parsed] = await db.execute<{ exact: string; words: number }>(
      sql`select websearch_to_tsquery('simple', ${text})::text as exact, numnode(websearch_to_tsquery('simple', ${text})) as words`,
    );
    if (!parsed || !Number(parsed.words)) return null;
    return { exact: parsed.exact, prefix: parsed.exact.replace(/'((?:[^']|'')*)'/g, "'$1':*") };
  }

  return {
    /** What `query` finds that `me` can see, at most `limit` of each kind asked for, best first. */
    async search(me: Participant, query: string, options: SearchOptions = {}): Promise<SearchResults> {
      const text = query.trim();
      const limit = options.limit ?? SEARCH_DEFAULT_LIMIT;
      const wanted = new Set(options.kinds?.length ? options.kinds : SEARCH_KINDS);
      const results = empty();
      if (!text) return results;
      const parsed = await parse(text);
      const number = wanted.has("cases") ? caseNumberIn(text) : null;
      if (!parsed && number === null) return results;

      // Cast, not `to_tsquery`, which would split the parsed words again.
      const exact = sql`${parsed?.exact ?? ""}::tsquery`;
      const prefix = sql`${parsed?.prefix ?? ""}::tsquery`;
      const q: Query = {
        matches: (column) => (parsed ? sql`${column} @@ ${prefix}` : sql`false`),
        rank: (column) => (parsed ? sql<number>`(2 * ts_rank_cd(${column}, ${exact}) + ts_rank_cd(${column}, ${prefix}))::real` : sql<number>`0::real`),
      };

      if (wanted.has("cases")) {
        const isReference = number === null ? sql`false` : sql`${cases.number} = ${number}`;
        const rank = sql<number>`(case when ${isReference} then ${REFERENCE_RANK} else ${q.rank(cases.search)} end)::real`;
        const found = page(
          await db
            .select({
              number: cases.number,
              title: cases.title,
              status: cases.status,
              severity: cases.severity,
              restricted: cases.restricted,
              rank,
            })
            .from(cases)
            .where(and(visibleCases(me), or(q.matches(cases.search), isReference)))
            .orderBy(desc(rank), desc(cases.updatedAt))
            .limit(limit + 1),
          limit,
        );
        results.cases = found.rows;
        results.more.cases = found.more;
      }
      if (!parsed) return results;

      if (wanted.has("alerts")) {
        const found = page(
          await db
            .select({
              id: alerts.id,
              externalId: alerts.externalId,
              title: alerts.title,
              severity: alerts.severity,
              status: alerts.status,
              host: alerts.host,
              userName: alerts.userName,
              integrationName: integrations.name,
              receivedAt: alerts.receivedAt,
              caseNumber: cases.number,
              caseTitle: cases.title,
              caseVisible: sql<boolean | null>`(${visibleCases(me)})`,
              rank: q.rank(alerts.search),
            })
            .from(alerts)
            .innerJoin(integrations, eq(alerts.integrationId, integrations.id))
            .leftJoin(cases, eq(alerts.caseId, cases.id))
            .where(
              and(
                eq(alerts.organizationId, me.organizationId),
                q.matches(alerts.search),
                // Guests find only the Alerts on their Cases that they are shown.
                isGuest(me) ? and(visibleCases(me), visibleItems(me, alerts.internal)) : undefined,
              ),
            )
            .orderBy(desc(q.rank(alerts.search)), desc(alerts.receivedAt), desc(alerts.seq))
            .limit(limit + 1),
          limit,
        );
        results.alerts = found.rows.map(({ integrationName, receivedAt, caseNumber, caseTitle, caseVisible, ...row }) => ({
          ...row,
          integration: { name: integrationName },
          receivedAt: receivedAt.toISOString(),
          case: caseNumber !== null && caseTitle !== null && caseVisible ? { number: caseNumber, title: caseTitle } : null,
        }));
        results.more.alerts = found.more;
      }

      const [observableResults, assetResults] = await Promise.all([
        wanted.has("observables") ? searchItems(me, q, observableKind, limit) : null,
        wanted.has("assets") ? searchItems(me, q, assetKind, limit) : null,
      ]);
      if (observableResults) {
        results.observables = observableResults.rows as ItemResult<ObservableType>[];
        results.more.observables = observableResults.more;
      }
      if (assetResults) {
        results.assets = assetResults.rows as ItemResult<AssetType>[];
        results.more.assets = assetResults.more;
      }
      return results;
    },
  };
}

type AnyColumn = typeof cases.search | typeof alerts.search | typeof observables.search;
