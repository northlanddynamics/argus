import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { isGuest, NotPermitted, visibleAlerts, visibleCases } from "../access/policy";
import type { AlertStatus } from "../alerts/vocabulary";
import type { Severity, Status } from "../cases/vocabulary";
import type { Db } from "../db/client";
import { alertObservables, alerts, caseObservables, cases, observables } from "../db/schema";
import type { Participant } from "../members/membership";
import { type Extracted, extractObservables } from "./extract";
import type { ObservableStore } from "./observables";

/**
 * Bulk Lookup (GLOSSARY.md): a Member pastes free text and sees every Observable in it
 * (`extract.ts`), each marked known or unknown, then links chosen ones to a Case they can work, as
 * ordinary hand links. Guests can't use it, so they can't probe what the Organization knows.
 *
 * An Observable is known when the Member can see a Case it is linked to or an Alert naming it, the
 * same as when its page can be opened; one only on Cases they can't see is unknown.
 */

/** The text is too large to look up at once; the message says why. */
export class LookupRefused extends Error {}

export type LookupCase = { number: number; title: string; status: Status; severity: Severity };
export type LookupAlert = {
  id: string;
  externalId: string;
  title: string;
  status: AlertStatus;
  severity: Severity;
  /** The Case it is attached to, unless that is a Case the Member can't see. */
  case: { number: number; title: string } | null;
};

export type LookupResult = Extracted & {
  /** Set when it is known: its page, and the Cases and Alerts it appears in, newest first. */
  known: { id: string; cases: LookupCase[]; alerts: LookupAlert[] } | null;
};

export const bulkLookupStore = ({ db }: { db: Db }, store: ObservableStore) => ({
  /** Every Observable in `text`, known or not. Throws `LookupRefused` when it is over the caps. */
  async lookup(me: Participant, text: string): Promise<LookupResult[]> {
    if (isGuest(me)) throw new NotPermitted();
    const extraction = extractObservables(text);
    if (!extraction.ok) throw new LookupRefused(extraction.reason);
    const found = extraction.observables;
    if (!found.length) return [];
    const held = await db
      .select({ id: observables.id, type: observables.type, key: observables.matchKey })
      .from(observables)
      .where(and(eq(observables.organizationId, me.organizationId), inArray(observables.matchKey, [...new Set(found.map((f) => f.value))])));
    const idOf = new Map(held.map((h) => [`${h.type} ${h.key}`, h.id]));
    const ids = [...idOf.values()];
    const [caseRows, alertRows] = ids.length
      ? await Promise.all([
          db
            .select({ itemId: caseObservables.itemId, number: cases.number, title: cases.title, status: cases.status, severity: cases.severity })
            .from(caseObservables)
            .innerJoin(cases, eq(caseObservables.caseId, cases.id))
            .where(and(inArray(caseObservables.itemId, ids), isNull(caseObservables.unlinkedAt), visibleCases(me)))
            .orderBy(desc(cases.number)),
          db
            .select({
              itemId: alertObservables.itemId,
              id: alerts.id,
              externalId: alerts.externalId,
              title: alerts.title,
              status: alerts.status,
              severity: alerts.severity,
              caseNumber: cases.number,
              caseTitle: cases.title,
            })
            .from(alertObservables)
            .innerJoin(alerts, eq(alertObservables.alertId, alerts.id))
            // Only an Alert on no Case or on a visible one gets here, so its Case can be shown.
            .leftJoin(cases, eq(alerts.caseId, cases.id))
            .where(and(inArray(alertObservables.itemId, ids), visibleAlerts(me, alerts.caseId)))
            .orderBy(desc(sql`coalesce(${alerts.detectedAt}, ${alerts.receivedAt})`), desc(alerts.seq)),
        ])
      : [[], []];
    return found.map((f) => {
      const id = idOf.get(`${f.type} ${f.value}`);
      const seenCases = caseRows
        .filter((c) => c.itemId === id)
        .map((c) => ({ number: c.number, title: c.title, status: c.status, severity: c.severity }));
      const seenAlerts = alertRows
        .filter((a) => a.itemId === id)
        .map((a) => ({
          id: a.id,
          externalId: a.externalId,
          title: a.title,
          status: a.status,
          severity: a.severity,
          case: a.caseNumber !== null && a.caseTitle !== null ? { number: a.caseNumber, title: a.caseTitle } : null,
        }));
      const known = id && (seenCases.length || seenAlerts.length) ? { id, cases: seenCases, alerts: seenAlerts } : null;
      return { ...f, known };
    });
  },

  /**
   * Links `values` to Case `number` as hand links, all or none. Throws as linking one does: the Case
   * isn't one `me` can see, it is Closed, or a value isn't valid.
   */
  async link(me: Participant, number: number, values: readonly Extracted[]) {
    if (isGuest(me)) throw new NotPermitted();
    return store.linkAll(me, number, values);
  },
});

export type BulkLookupStore = ReturnType<typeof bulkLookupStore>;
