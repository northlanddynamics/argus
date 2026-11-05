import { and, desc, eq, exists, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { isGuest, visibleAlerts, visibleCases, visibleItems } from "../access/policy";
import type { AlertStatus } from "../alerts/vocabulary";
import type { Severity, Status } from "../cases/vocabulary";
import type { Db } from "../db/client";
import { alertAssets, alertObservables, alerts, assets, caseAssets, caseObservables, cases, integrations, observables } from "../db/schema";
import type { Participant } from "../members/membership";
import type { AssetType, ObservableType } from "../observables/vocabulary";
import { EXACT_ONLY_TYPES, readIndicator, refangWords, type IndicatorQuery } from "./indicators";
import { SEARCH_DEFAULT_PAGE_SIZE, SEARCH_KINDS, type SearchKind } from "./vocabulary";

/**
 * Global search: Cases (by title and Case Summary), Alerts (by title, Falcon's id, host, user and
 * description), Observables and Assets (by value), with Postgres full-text search over the `search`
 * columns (`db/argus-schema.ts`). The query is read as a web search: words, "quoted phrases", `or`
 * and `-excluded`. Each word also matches as the start of a longer one, so results come as the query
 * is typed ("invo" finds invoice-portal.biz); whole-word matches rank higher.
 *
 * Every kind is ranked on one scale and returned as one list, best first, a page at a time, with how
 * many of each kind match. Typing a Case's reference ("C-12", or "12") puts that Case first.
 *
 * Observables and Assets are also found by indicator (`indicators.ts`), as analysts paste them: the
 * query is refanged and normalised as stored values are, and an exact match ranks above any text
 * match. A domain also finds its subdomains, and URLs and email addresses on it or a subdomain; 8 or
 * more hex characters find the hashes they start. IPs and hashes match only so, never by full text,
 * so part of an IP, or a short run of hex, finds none.
 *
 * Results go through the access policy like every other read:
 * - Cases: those `visibleCases` lets the actor see, so Restricted Cases never leak.
 * - Alerts: Members search the whole Alert queue, and are shown the Case an Alert is on only if they
 *   can see it. Guests find only Alerts attached to their Cases that aren't Internal.
 * - Observables and Assets: those linked to a Case the actor can see and, for Members, those an
 *   Alert names. Each lists the Cases it is linked to among those the actor can see.
 */

type CaseRef = { number: number; title: string };

type CaseHit = { number: number; title: string; status: Status; severity: Severity; restricted: boolean };
type AlertHit = {
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
};
type ItemHit<Type extends string> = {
  id: string;
  type: Type;
  value: string;
  /** The Cases it is linked to that the actor can see, newest first. */
  cases: CaseRef[];
};

/** One result: its kind, how well it matches (comparable across kinds; higher is better) and what it is. */
export type SearchHit =
  | { kind: "cases"; rank: number; item: CaseHit }
  | { kind: "alerts"; rank: number; item: AlertHit }
  | { kind: "observables"; rank: number; item: ItemHit<ObservableType> }
  | { kind: "assets"; rank: number; item: ItemHit<AssetType> };

export type SearchResults = {
  /** This page of results, best first. */
  hits: SearchHit[];
  /** How many results of the kinds searched there are in all. */
  total: number;
  /** How many results of each kind there are, whichever kinds were searched. */
  counts: Record<SearchKind, number>;
  page: number;
  pageSize: number;
};

export type SearchOptions = {
  /** Which kinds to list; all of them when empty or left out. */
  kinds?: readonly SearchKind[];
  /** Which page, from 1. */
  page?: number;
  pageSize?: number;
};

const noCounts = (): Record<SearchKind, number> => ({ cases: 0, alerts: 0, observables: 0, assets: 0 });

/** The Case number a query names, as in "C-12", "c12", "#12" or "12"; else null. */
const caseNumberIn = (query: string) => {
  const match = /^#?(?:c-?)?(\d{1,9})$/i.exec(query.trim());
  return match ? Number(match[1]) : null;
};

/** A Case named by its reference ranks above any text match. */
const REFERENCE_RANK = 1000;
/** An Observable or Asset whose normalised value is the query's ranks above any text match. */
const EXACT_INDICATOR_RANK = 500;
/** One the query finds as an indicator otherwise (a subdomain, a URL on the domain, a hash by prefix). */
const RELATED_INDICATOR_RANK = 100;

/** A host is `domain` or one of its subdomains. */
const onDomain = (host: SQL, domain: string) => sql`(${host} = ${domain} or right(${host}, ${domain.length + 1}) = ${`.${domain}`})`;

/** Whether an Observable is the one `indicator` names (`exact`), or one it otherwise finds (`related`). */
function observableIndicator(indicator: IndicatorQuery) {
  const { type, matchKey } = observables;
  const exact = indicator.observables.length
    ? or(...indicator.observables.map((o) => and(eq(type, o.type), eq(matchKey, o.key))))!
    : sql`false`;
  const related: SQL[] = [];
  if (indicator.domain) {
    const d = indicator.domain;
    related.push(
      sql`(${type} = 'domain' and ${onDomain(sql`${matchKey}`, d)})`,
      // The host of a URL as the browser writes it: lowercase, after any user info, before any port.
      sql`(${type} = 'url' and ${onDomain(sql`substring(${matchKey} from '^[a-z][a-z0-9+.-]*://(?:[^@/]*@)?([^/:?#]+)')`, d)})`,
      sql`(${type} = 'email' and ${onDomain(sql`substring(${matchKey} from '@([^@]+)$')`, d)})`,
    );
  }
  if (indicator.hashPrefix) {
    const p = indicator.hashPrefix;
    related.push(sql`(${type} in ('md5', 'sha1', 'sha256') and left(${matchKey}, ${p.length}) = ${p})`);
  }
  return { exact, related: related.length ? sql`(${sql.join(related, sql` or `)})` : sql`false` };
}

/** Whether an Asset is the one `indicator` names. */
const assetIndicator = (indicator: IndicatorQuery) =>
  indicator.assets.length ? or(...indicator.assets.map((a) => and(eq(assets.type, a.type), eq(assets.matchKey, a.key))))! : sql`false`;

export function searchStore({ db }: { db: Db }) {
  const itemKinds = {
    observables: { items: observables, links: caseObservables, alertLinks: alertObservables },
    assets: { items: assets, links: caseAssets, alertLinks: alertAssets },
  } as const;
  type ItemKind = (typeof itemKinds)[keyof typeof itemKinds];

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

  /** Observables or Assets `me` may find: linked to a Case they can see, or (Members) named by an Alert. */
  const findableItem = (me: Participant, { items, links, alertLinks }: ItemKind) =>
    or(
      exists(
        db
          .select({ one: sql`1` })
          .from(links)
          .innerJoin(cases, eq(links.caseId, cases.id))
          .where(and(eq(links.itemId, items.id), isNull(links.unlinkedAt), visibleCases(me))),
      ),
      // Members see what the Alerts they can see name too.
      isGuest(me)
        ? undefined
        : exists(
            db
              .select({ one: sql`1` })
              .from(alertLinks)
              .innerJoin(alerts, eq(alertLinks.alertId, alerts.id))
              .where(and(eq(alertLinks.itemId, items.id), visibleAlerts(me, alerts.caseId))),
          ),
    );

  /** The Cases each of `ids` is linked to that `me` can see, newest first. */
  async function linkedCases(me: Participant, { links }: ItemKind, ids: string[]) {
    if (!ids.length) return new Map<string, CaseRef[]>();
    const rows = await db
      .select({ itemId: links.itemId, number: cases.number, title: cases.title })
      .from(links)
      .innerJoin(cases, eq(links.caseId, cases.id))
      .where(and(inArray(links.itemId, ids), isNull(links.unlinkedAt), visibleCases(me)))
      .orderBy(desc(cases.number));
    const byItem = new Map<string, CaseRef[]>();
    for (const { itemId, number, title } of rows) byItem.set(itemId, [...(byItem.get(itemId) ?? []), { number, title }]);
    return byItem;
  }

  async function itemHits(me: Participant, kind: ItemKind, ids: string[]) {
    if (!ids.length) return new Map<string, ItemHit<string>>();
    const { items } = kind;
    const rows = await db.select({ id: items.id, type: items.type, value: items.value }).from(items).where(inArray(items.id, ids));
    const linked = await linkedCases(me, kind, ids);
    return new Map(rows.map((r) => [r.id, { ...r, cases: linked.get(r.id) ?? [] }]));
  }

  async function caseHits(ids: string[]) {
    if (!ids.length) return new Map<string, CaseHit>();
    const rows = await db
      .select({ id: cases.id, number: cases.number, title: cases.title, status: cases.status, severity: cases.severity, restricted: cases.restricted })
      .from(cases)
      .where(inArray(cases.id, ids));
    return new Map(rows.map(({ id, ...row }) => [id, row]));
  }

  async function alertHits(me: Participant, ids: string[]) {
    if (!ids.length) return new Map<string, AlertHit>();
    const rows = await db
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
      .where(inArray(alerts.id, ids));
    return new Map(
      rows.map(({ integrationName, receivedAt, caseNumber, caseTitle, caseVisible, ...row }) => [
        row.id,
        {
          ...row,
          integration: { name: integrationName },
          receivedAt: receivedAt.toISOString(),
          case: caseNumber !== null && caseTitle !== null && caseVisible ? { number: caseNumber, title: caseTitle } : null,
        },
      ]),
    );
  }

  return {
    /**
     * What `query` finds that `me` can see, as one list best first, a page at a time: the kinds in
     * `options.kinds` (all when none), with how many of every kind match.
     */
    async search(me: Participant, query: string, options: SearchOptions = {}): Promise<SearchResults> {
      const text = query.trim();
      const page = Math.max(1, options.page ?? 1);
      const pageSize = options.pageSize ?? SEARCH_DEFAULT_PAGE_SIZE;
      const wanted = options.kinds?.length ? SEARCH_KINDS.filter((k) => options.kinds!.includes(k)) : [...SEARCH_KINDS];
      const none: SearchResults = { hits: [], total: 0, counts: noCounts(), page, pageSize };
      if (!text) return none;
      const parsed = await parse(refangWords(text));
      const number = caseNumberIn(text);
      if (!parsed && number === null) return none;
      const indicator = readIndicator(text);

      // Cast, not `to_tsquery`, which would split the parsed words again.
      const exact = sql`${parsed?.exact ?? ""}::tsquery`;
      const prefix = sql`${parsed?.prefix ?? ""}::tsquery`;
      const matches = (column: SQL | AnyColumn) => (parsed ? sql`${column} @@ ${prefix}` : sql`false`);
      const rank = (column: AnyColumn) =>
        parsed ? sql`(2 * ts_rank_cd(${column}, ${exact}) + ts_rank_cd(${column}, ${prefix}))` : sql`0`;

      // Every match the actor may see, as (kind, id, rank, at); `at` breaks ties, newest first.
      const isReference = number === null ? sql`false` : sql`${cases.number} = ${number}`;
      const matching = sql.join(
        [
          sql`select 'cases' as kind, 0 as kind_order, ${cases.id} as id,
            (case when ${isReference} then ${REFERENCE_RANK} else ${rank(cases.search)} end)::real as rank, ${cases.updatedAt} as at
            from ${cases} where ${and(visibleCases(me), or(matches(cases.search), isReference))}`,
          sql`select 'alerts', 1, ${alerts.id}, ${rank(alerts.search)}::real, ${alerts.receivedAt}
            from ${alerts} left join ${cases} on ${eq(alerts.caseId, cases.id)}
            where ${and(
              eq(alerts.organizationId, me.organizationId),
              matches(alerts.search),
              // Guests find only the Alerts on their Cases that they are shown; Members those not on a Case they can't see.
              isGuest(me) ? and(visibleCases(me), visibleItems(me, alerts.internal)) : visibleAlerts(me, alerts.caseId),
            )}`,
          (() => {
            const { exact: named, related } = observableIndicator(indicator);
            // IPs and hashes are found only as indicators: a text match on one is a partial match.
            const byText = and(notInArray(observables.type, [...EXACT_ONLY_TYPES]), matches(observables.search));
            return sql`select 'observables', 2, ${observables.id},
              (case when ${named} then ${EXACT_INDICATOR_RANK} when ${related} then ${RELATED_INDICATOR_RANK}
                else ${rank(observables.search)} end)::real,
              ${observables.createdAt}
              from ${observables}
              where ${and(eq(observables.organizationId, me.organizationId), or(byText, named, related), findableItem(me, itemKinds.observables))}`;
          })(),
          (() => {
            const named = assetIndicator(indicator);
            return sql`select 'assets', 3, ${assets.id},
              (case when ${named} then ${EXACT_INDICATOR_RANK} else ${rank(assets.search)} end)::real, ${assets.createdAt}
              from ${assets}
              where ${and(eq(assets.organizationId, me.organizationId), or(matches(assets.search), named), findableItem(me, itemKinds.assets))}`;
          })(),
        ],
        sql` union all `,
      );

      const countRows = await db.execute<{ kind: SearchKind; n: number }>(
        sql`select kind, count(*)::int as n from (${matching}) as matching group by kind`,
      );
      const counts = noCounts();
      for (const { kind, n } of countRows) counts[kind] = Number(n);
      const total = wanted.reduce((sum, k) => sum + counts[k], 0);

      const pageRows = await db.execute<{ kind: SearchKind; id: string; rank: number }>(
        sql`select kind, id, rank from (${matching}) as matching
          where kind in (${sql.join(
            wanted.map((k) => sql`${k}`),
            sql`, `,
          )})
          order by rank desc, kind_order, at desc, id
          limit ${pageSize} offset ${(page - 1) * pageSize}`,
      );
      const idsOf = (kind: SearchKind) => pageRows.filter((r) => r.kind === kind).map((r) => r.id);
      const [caseItems, alertItems, observableItems, assetItems] = await Promise.all([
        caseHits(idsOf("cases")),
        alertHits(me, idsOf("alerts")),
        itemHits(me, itemKinds.observables, idsOf("observables")),
        itemHits(me, itemKinds.assets, idsOf("assets")),
      ]);
      const hits = pageRows.flatMap(({ kind, id, rank: score }): SearchHit[] => {
        const r = Number(score);
        switch (kind) {
          case "cases": {
            const item = caseItems.get(id);
            return item ? [{ kind, rank: r, item }] : [];
          }
          case "alerts": {
            const item = alertItems.get(id);
            return item ? [{ kind, rank: r, item }] : [];
          }
          case "observables": {
            const item = observableItems.get(id);
            return item ? [{ kind, rank: r, item: item as ItemHit<ObservableType> }] : [];
          }
          case "assets": {
            const item = assetItems.get(id);
            return item ? [{ kind, rank: r, item: item as ItemHit<AssetType> }] : [];
          }
        }
      });
      return { hits, total, counts, page, pageSize };
    },
  };
}

type AnyColumn = typeof cases.search | typeof alerts.search | typeof observables.search;
