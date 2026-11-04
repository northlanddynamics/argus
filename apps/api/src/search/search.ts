import { and, desc, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { isGuest, visibleCases, visibleItems } from "../access/policy";
import type { Db } from "../db/client";
import { alertAssets, alertObservables, alerts, assets, caseAssets, caseObservables, cases, integrations, observables } from "../db/schema";
import type { AlertStatus } from "../alerts/vocabulary";
import type { Severity, Status } from "../cases/vocabulary";
import type { Participant } from "../members/membership";
import type { AssetType, ObservableType } from "../observables/vocabulary";

/**
 * Global search: Cases (by title and Case Summary), Alerts (by title, Falcon's id, host, user and
 * description), Observables and Assets (by value), with Postgres full-text search over the `search`
 * columns (`db/argus-schema.ts`). The query is read as a web search: words, "quoted phrases", `or`
 * and `-excluded`.
 *
 * Results go through the access policy like every other read:
 * - Cases: those `visibleCases` lets the actor see, so Restricted Cases never leak.
 * - Alerts: Members search the whole Alert queue, and are shown the Case an Alert is on only if they
 *   can see it. Guests find only Alerts attached to their Cases that aren't Internal.
 * - Observables and Assets: those linked to a Case the actor can see and, for Members, those an
 *   Alert names. Each lists the Cases it is linked to among those the actor can see.
 *
 * Typing a Case's reference ("C-12", or "12") finds that Case too, if the actor can see it.
 */

/** At most this many results of each kind, best first. */
export const SEARCH_LIMIT = 20;

type CaseRef = { number: number; title: string };

export type SearchResults = {
  cases: { number: number; title: string; status: Status; severity: Severity; restricted: boolean }[];
  alerts: {
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
  }[];
  observables: ItemResult<ObservableType>[];
  assets: ItemResult<AssetType>[];
};

type ItemResult<Type extends string> = {
  id: string;
  type: Type;
  value: string;
  /** The Cases it is linked to that the actor can see, newest first. */
  cases: CaseRef[];
};

const empty = (): SearchResults => ({ cases: [], alerts: [], observables: [], assets: [] });

/** The Case number a query names, as in "C-12", "c12", "#12" or "12"; else null. */
const caseNumberIn = (query: string) => {
  const match = /^#?(?:c-?)?(\d{1,9})$/i.exec(query.trim());
  return match ? Number(match[1]) : null;
};

export function searchStore({ db }: { db: Db }) {
  const observableKind = { items: observables, links: caseObservables, alertLinks: alertObservables };
  const assetKind = { items: assets, links: caseAssets, alertLinks: alertAssets };

  async function searchItems(me: Participant, tsquery: SQL, kind: typeof observableKind): Promise<ItemResult<string>[]> {
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
    const rows = await db
      .select({ id: items.id, type: items.type, value: items.value })
      .from(items)
      .where(and(eq(items.organizationId, me.organizationId), sql`${items.search} @@ ${tsquery}`, or(onVisibleCase, namedByAlert)))
      .orderBy(desc(sql`ts_rank_cd(${items.search}, ${tsquery})`), items.value)
      .limit(SEARCH_LIMIT);
    if (!rows.length) return [];
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
    return rows.map((r) => ({
      ...r,
      cases: linked.filter((l) => l.itemId === r.id).map(({ number, title }) => ({ number, title })),
    }));
  }

  return {
    /** What `query` finds that `me` can see, at most `SEARCH_LIMIT` of each kind, best first. */
    async search(me: Participant, query: string): Promise<SearchResults> {
      const text = query.trim();
      if (!text) return empty();
      const tsquery = sql`websearch_to_tsquery('simple', ${text})`;
      // A query of only punctuation or excluded words matches nothing.
      const [parsed] = await db.execute<{ usable: boolean }>(sql`select numnode(${tsquery}) > 0 as usable`);
      const usable = !!parsed?.usable;
      const number = caseNumberIn(text);
      if (!usable && number === null) return empty();
      const matches = (column: AnyColumn) => (usable ? sql`${column} @@ ${tsquery}` : sql`false`);
      const rank = (column: AnyColumn) => sql`ts_rank_cd(${column}, ${tsquery})`;

      const caseRows = await db
        .select({ number: cases.number, title: cases.title, status: cases.status, severity: cases.severity, restricted: cases.restricted })
        .from(cases)
        .where(and(visibleCases(me), or(matches(cases.search), number === null ? undefined : eq(cases.number, number))))
        .orderBy(
          ...[
            number === null ? undefined : desc(sql`${cases.number} = ${number}`),
            usable ? desc(rank(cases.search)) : undefined,
            desc(cases.updatedAt),
          ].filter((order) => order !== undefined),
        )
        .limit(SEARCH_LIMIT);
      if (!usable) return { ...empty(), cases: caseRows };

      const alertRows = await db
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
        })
        .from(alerts)
        .innerJoin(integrations, eq(alerts.integrationId, integrations.id))
        .leftJoin(cases, eq(alerts.caseId, cases.id))
        .where(
          and(
            eq(alerts.organizationId, me.organizationId),
            matches(alerts.search),
            // Guests find only the Alerts on their Cases that they are shown.
            isGuest(me) ? and(visibleCases(me), visibleItems(me, alerts.internal)) : undefined,
          ),
        )
        .orderBy(desc(rank(alerts.search)), desc(alerts.receivedAt), desc(alerts.seq))
        .limit(SEARCH_LIMIT);

      const [observableResults, assetResults] = await Promise.all([
        searchItems(me, tsquery, observableKind),
        searchItems(me, tsquery, assetKind),
      ]);
      return {
        cases: caseRows,
        alerts: alertRows.map(({ integrationName, receivedAt, caseNumber, caseTitle, caseVisible, ...row }) => ({
          ...row,
          integration: { name: integrationName },
          receivedAt: receivedAt.toISOString(),
          case: caseNumber !== null && caseTitle !== null && caseVisible ? { number: caseNumber, title: caseTitle } : null,
        })),
        observables: observableResults as ItemResult<ObservableType>[],
        assets: assetResults as ItemResult<AssetType>[],
      };
    },
  };
}

type AnyColumn = typeof cases.search | typeof alerts.search;
