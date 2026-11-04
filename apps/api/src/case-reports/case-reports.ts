import { and, eq } from "drizzle-orm";
import { casePolicy, isGuest, NotPermitted, visibleCases } from "../access/policy";
import { actorOf, CaseNotFound } from "../cases/cases";
import { recordCaseAudit } from "../cases/case-audit-log";
import { caseRef } from "../cases/vocabulary";
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import { cases } from "../db/schema";
import type { Participant } from "../members/membership";
import type { CaseStore } from "../cases/cases";
import type { EvidenceStore } from "../evidence/evidence";
import type { AssetStore, ObservableStore } from "../observables/observables";
import type { TaskStore } from "../tasks/tasks";
import type { TimelineStore } from "../timeline/timeline";
import { toMarkdown } from "./markdown";
import { toPdf } from "./pdf";
import { type ReportFormat, type ReportVariant, reportFormatLabel, reportVariantLabel } from "./vocabulary";

/**
 * Case Reports: a point-in-time document of a Case (its Summary, Timeline, Tasks, Observables,
 * Assets, and Evidence with SHA-256 fingerprints), in PDF or Markdown, complete or Guest-safe.
 *
 * The report holds what its reader may see, read through the item modules. The Guest-safe variant is
 * read the way the Case's Guests read it (`readsAs: "guests"` in the access policy), so it leaves
 * out every Internal item, and what Guests never see: the Audit Log, other Cases and Alerts. Guests
 * export only that one. Every export is recorded in the Case Audit Log before it is handed over.
 */

export { CaseNotFound, NotPermitted };

/** The modules a report is read through. */
type Readers = {
  cases: CaseStore;
  tasks: TaskStore;
  timeline: TimelineStore;
  observables: ObservableStore;
  assets: AssetStore;
  evidence: EvidenceStore;
};

export type CaseReport = {
  variant: ReportVariant;
  generatedAt: string;
  generatedBy: string;
  organizationName: string;
  case: Awaited<ReturnType<Readers["cases"]["view"]>>;
  timeline: Awaited<ReturnType<Readers["timeline"]["list"]>>;
  tasks: Awaited<ReturnType<Readers["tasks"]["list"]>>;
  observables: Awaited<ReturnType<Readers["observables"]["list"]>>;
  assets: Awaited<ReturnType<Readers["assets"]["list"]>>;
  evidence: Awaited<ReturnType<Readers["evidence"]["list"]>>;
};

export type ExportedReport = { fileName: string; contentType: string; body: Uint8Array };

const CONTENT_TYPES: Record<ReportFormat, string> = { pdf: "application/pdf", markdown: "text/markdown; charset=utf-8" };
const EXTENSIONS: Record<ReportFormat, string> = { pdf: "pdf", markdown: "md" };

export function caseReportStore({ db, clock }: { db: Db; clock: Clock }, readers: Readers) {
  /** What `me` may put in the `variant` report of Case `number`; throws `CaseNotFound` when they can't see it. */
  async function gather(me: Participant, number: number, variant: ReportVariant): Promise<CaseReport> {
    if (variant === "complete" && !casePolicy.canExportCompleteReport(me)) throw new NotPermitted();
    const reader: Participant = variant === "guest_safe" && !isGuest(me) ? { ...me, readsAs: "guests" } : me;
    const [found, timeline, tasks, observables, assets, evidence] = await Promise.all([
      readers.cases.view(reader, number),
      readers.timeline.list(reader, number),
      readers.tasks.list(reader, number),
      readers.observables.list(reader, number),
      readers.assets.list(reader, number),
      readers.evidence.list(reader, number),
    ]);
    return {
      variant,
      generatedAt: clock.now().toISOString(),
      generatedBy: me.name,
      organizationName: me.organizationName,
      case: found,
      timeline,
      tasks,
      observables,
      assets,
      evidence,
    };
  }

  return {
    gather,

    /**
     * The `variant` Case Report of Case `number` as a `format` file, once its export is recorded in
     * the Case Audit Log. Throws `CaseNotFound` when `me` can't see the Case, and `NotPermitted` when
     * a Guest asks for the complete one. Closed Cases export too.
     */
    async export(me: Participant, number: number, variant: ReportVariant, format: ReportFormat): Promise<ExportedReport> {
      const report = await gather(me, number, variant);
      const body = format === "pdf" ? await toPdf(report) : new TextEncoder().encode(toMarkdown(report));
      await db.transaction(async (tx) => {
        const [found] = await tx
          .select({ id: cases.id })
          .from(cases)
          .where(and(visibleCases(me), eq(cases.number, number)))
          .limit(1);
        if (!found) throw new CaseNotFound();
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: found.id,
          occurredAt: new Date(report.generatedAt),
          actor: actorOf(me),
          action: "case.report_exported",
          target: `${reportVariantLabel[variant]} Case Report (${reportFormatLabel[format]})`,
        });
      });
      const variantSlug = variant === "guest_safe" ? "guest-safe" : "complete";
      return {
        fileName: `${caseRef(number)}-case-report-${variantSlug}.${EXTENSIONS[format]}`,
        contentType: CONTENT_TYPES[format],
        body,
      };
    },
  };
}

export type CaseReportStore = ReturnType<typeof caseReportStore>;
