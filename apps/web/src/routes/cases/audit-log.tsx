import { useQuery } from "@tanstack/react-query";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { DatePicker } from "@/components/date-picker";
import { DATE_FILTER, FilterBar, FilterField, FilterSelect } from "@/components/filter-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { falconStatusLabel } from "@/lib/alerts";
import { api } from "@/lib/api";
import {
  CASE_AUDIT_ACTIONS,
  type CaseAuditAction,
  type Resolution,
  resolutionLabel,
  type CaseSummary,
  caseQuery,
  caseTypeLabel,
  type CaseType,
  severityLabel,
  type Severity,
  statusLabel,
  type Status,
  summaryText,
} from "@/lib/cases";
import { defang, observableTypeLabel } from "@/lib/observables";
import { promotedSources, timelineQuery } from "@/lib/timeline";
import { useContainerWidth } from "@/hooks/use-container-width";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { QUIET_ACTION } from "@/routes/cases/rail";
import { PromoteDialog } from "@/routes/cases/timeline-entry-form";
import { membersKey } from "@/routes/settings/members";

export const actionLabel: Record<CaseAuditAction, string> = {
  "case.opened": "Opened Case",
  "case.status_changed": "Changed Status",
  "case.severity_changed": "Changed Severity",
  "case.case_type_changed": "Changed Case Type",
  "case.assignee_changed": "Changed Assignee",
  "case.restricted_changed": "Changed Restricted",
  "case.summary_edited": "Edited Case Summary",
  "case.closed": "Closed Case",
  "case.reopened": "Reopened Case",
  "task.created": "Created Task",
  "task.title_changed": "Renamed Task",
  "task.description_changed": "Changed Task description",
  "task.owner_changed": "Changed Task owner",
  "task.due_date_changed": "Changed Task due date",
  "task.completed": "Completed Task",
  "task.reopened": "Reopened Task",
  "case_role.assigned": "Gave Case Role to",
  "case_role.unassigned": "Took Case Role from",
  "discussion.message_posted": "Posted message",
  "discussion.message_edited": "Edited message",
  "discussion.message_retracted": "Retracted message",
  "timeline.entry_added": "Added Timeline Entry",
  "timeline.entry_promoted": "Promoted to Timeline",
  "timeline.entry_edited": "Edited Timeline Entry",
  "timeline.entry_retracted": "Retracted Timeline Entry",
  "evidence.added": "Added Evidence",
  "evidence.viewed": "Viewed Evidence",
  "evidence.downloaded": "Downloaded Evidence",
  "guest.invited": "Invited Guest",
  "guest.removed": "Removed Guest",
  "observable.linked": "Added Observable",
  "observable.unlinked": "Unlinked Observable",
  "asset.linked": "Added Asset",
  "asset.unlinked": "Unlinked Asset",
  "case_link.added": "Linked Case",
  "case_link.removed": "Unlinked Case",
  "tag.added": "Added Tag",
  "tag.removed": "Removed Tag",
  "alert.attached": "Attached Alert",
  "alert.detached": "Detached Alert",
  "alert.falcon_status_changed": "Changed Falcon status of Alert",
  "alert.falcon_assignee_changed": "Changed Falcon assignee of Alert",
  "alert.falcon_tags_changed": "Changed Falcon tags of Alert",
  "item.marked_internal": "Marked Internal",
  "item.shown_to_guests": "Showed to Guests",
  "case.report_exported": "Exported",
  "response_action.requested": "Took Response Action",
  "response_action.sent": "Sent Response Action",
  "response_action.failed": "Response Action failed",
  "response_action.retried": "Retried Response Action",
  "response_action.already_present": "Response Action already sent",
  "response_action.already_in_tool": "Response Action already in tool",
  "response_action.dismissed": "Dismissed Response Action",
  "response_action.removal_requested": "Asked to remove Response Action",
  "response_action.removal_retried": "Retried removing Response Action",
  "response_action.removal_failed": "Removing Response Action failed",
  "response_action.removed": "Removed Response Action",
};

/** A recorded value as people read it: "In Progress" rather than "in_progress". */
function shown(action: CaseAuditAction, value: string | null) {
  if (value === null) return "—";
  switch (action) {
    case "case.status_changed":
      return statusLabel[value as Status] ?? value;
    // Closing moves from a Status to a Resolution; reopening from the Resolution back to a Status.
    case "case.closed":
    case "case.reopened":
      return statusLabel[value as Status] ?? resolutionLabel[value as Resolution] ?? value;
    case "alert.falcon_status_changed":
      return falconStatusLabel[value] ?? value;
    case "case.severity_changed":
      return severityLabel[value as Severity] ?? value;
    case "case.case_type_changed":
      return caseTypeLabel[value as CaseType] ?? value;
    case "case.restricted_changed":
      return value === "true" ? "Restricted" : "Not Restricted";
    case "case.summary_edited": {
      const text = summaryText(JSON.parse(value) as CaseSummary).replaceAll("\n", " ");
      return text.length > 80 ? `${text.slice(0, 80)}…` : text || "(empty)";
    }
    case "task.description_changed":
      return value.length > 80 ? `${value.slice(0, 80)}…` : value || "(empty)";
    default:
      return value;
  }
}

/**
 * What an entry is about, as people read it. Observable values are defanged, as on the Observables
 * tab, so a URL copied from the Audit Log is never live.
 */
function shownTarget(action: CaseAuditAction, target: string) {
  if (!action.startsWith("observable.")) return target;
  for (const [type, label] of Object.entries(observableTypeLabel) as [keyof typeof observableTypeLabel, string][]) {
    if (target.startsWith(`${label} `)) return `${label} ${defang(type, target.slice(label.length + 1))}`;
  }
  return target;
}

type Entry = { id: string; occurredAt: string; action: CaseAuditAction; target: string | null; before: string | null; after: string | null };

/** An entry in words, as the starting text of a Timeline Entry Promoted from it. */
const entryText = (e: Entry) => {
  const what = `${actionLabel[e.action] ?? e.action}${e.target === null ? "" : ` ${shownTarget(e.action, e.target)}`}`;
  if (e.before === null && e.after === null) return what;
  const change = e.before === null ? shown(e.action, e.after) : `${shown(e.action, e.before)} → ${shown(e.action, e.after)}`;
  return `${what}: ${change}`;
};


/** "New → In Progress": what an entry changed. An addition or removal has no before and after to show. */
function BeforeAfter({ entry: e }: { entry: Entry }) {
  if (e.before === null && e.after === null) return null;
  return (
    <span className="font-mono">
      {e.before !== null && <span className="text-muted-foreground line-through">{shown(e.action, e.before)}</span>}
      {e.before !== null && " "}→ {shown(e.action, e.after)}
    </span>
  );
}

export function CaseAuditLogPage() {
  const number = useCaseNumber();
  const { data: c } = useQuery(caseQuery(number));
  const timeline = useQuery(timelineQuery(number));
  const promoted = promotedSources(timeline.data);
  const [promoting, setPromoting] = useState<Entry | null>(null);
  const [actor, setActor] = useState("");
  const [action, setAction] = useState<CaseAuditAction | "">("");
  const [from, setFrom] = useState("");
  const { ref, fits } = useContainerWidth<HTMLDivElement>();

  const entries = useQuery({
    queryKey: ["cases", number, "audit-log", { actor, action, from }],
    queryFn: async () => {
      const query = {
        ...(actor && { actor }),
        ...(action && { action }),
        // A date picked in the browser means midnight where the viewer is.
        ...(from && { from: new Date(`${from}T00:00`).toISOString() }),
      };
      const res = await api.cases[":number"]["audit-log"].$get({ param: { number: String(number) }, query });
      const body = await res.json();
      if (!("entries" in body)) throw new Error("Could not load the Audit Log");
      return body.entries;
    },
  });
  const members = useQuery({
    queryKey: membersKey,
    queryFn: async () => (await api.organization.members.$get()).json(),
  });
  const actors = members.data?.members.map((m) => m.userId) ?? [];
  const actorNames = Object.fromEntries(members.data?.members.map((m) => [m.userId, m.name]) ?? []);
  const filtered = Boolean(actor || action || from);
  const clear = () => {
    setActor("");
    setAction("");
    setFrom("");
  };

  return (
    <div className="grid gap-3">
      <FilterBar onClear={filtered ? clear : undefined}>
        <FilterSelect label="Actor" id="audit-actor" any="Anyone" value={actor || undefined} options={actors} labels={actorNames} onChange={(next) => setActor(next ?? "")} />
        <FilterSelect label="Action" id="audit-action" any="All actions" value={action || undefined} options={CASE_AUDIT_ACTIONS} labels={actionLabel} onChange={(next) => setAction(next ?? "")} />
        <FilterField label="From" htmlFor="audit-from">
          <DatePicker id="audit-from" value={from} onChange={setFrom} placeholder="Any time" className={DATE_FILTER} />
        </FilterField>
      </FilterBar>
      <Card ref={ref} className="@container py-0">
        <Table className="table-fixed" aria-label="Case Audit Log">
          {/* Set widths, so the columns hold still as filters change what's listed; Action takes the rest.
              On a narrow card When, Actor and Before → After give way and show under the Action instead; on
              a wide page Action and Before → After stop at 40rem and the last column takes the slack. */}
          <colgroup>
            <col className="w-0 @xl:w-32 @4xl:w-36" />
            <col className="w-0 @2xl:w-36" />
            <col className="@7xl:w-[40rem]" />
            <col className="w-0 @5xl:w-[28%] @7xl:w-[40rem]" />
            <col className="w-28 @4xl:w-32 @7xl:w-auto" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="overflow-hidden px-0 @xl:pl-4">{fits("xl") && "When"}</TableHead>
              <TableHead className="overflow-hidden px-0 @2xl:px-2">{fits("2xl") && "Actor"}</TableHead>
              <TableHead className="pl-4 @xl:pl-2">Action</TableHead>
              <TableHead className="overflow-hidden px-0 @5xl:px-2">{fits("5xl") && "Before → After"}</TableHead>
              <TableHead className="pr-4">
                <span className="sr-only">Promote</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.isPending &&
              Array.from({ length: 6 }, (_, i) => (
                <TableRow key={i} className="hover:bg-transparent" aria-hidden>
                  <TableCell className="overflow-hidden px-0 @xl:pl-4"><Skeleton className="hidden h-4 w-24 @xl:block" /></TableCell>
                  <TableCell className="overflow-hidden px-0 @2xl:px-2"><Skeleton className="hidden h-4 w-24 @2xl:block" /></TableCell>
                  <TableCell className="pl-4 @xl:pl-2"><Skeleton className="h-4 w-3/5" /></TableCell>
                  <TableCell className="overflow-hidden px-0 @5xl:px-2"><Skeleton className="hidden h-4 w-2/5 @5xl:block" /></TableCell>
                  <TableCell className="pr-4" />
                </TableRow>
              ))}
            {entries.data?.map((e) => (
              <TableRow key={e.id} className="group/row">
                <TableCell className="truncate px-0 text-muted-foreground @xl:pl-4">{fits("xl") && <Time iso={e.occurredAt} />}</TableCell>
                <TableCell className="truncate px-0 @2xl:px-2" title={e.actor.name}>
                  {fits("2xl") && e.actor.name}
                </TableCell>
                {/* Hashes and URLs wrap anywhere, so the full value stays on the record without widening the table. */}
                <TableCell className="pl-4 whitespace-normal [overflow-wrap:anywhere] @xl:pl-2">
                  {actionLabel[e.action] ?? e.action}
                  {e.target !== null && <span className="font-medium"> {shownTarget(e.action, e.target)}</span>}
                  {/* What the columns that have given way hold, under the Action. */}
                  {(!fits("2xl") || (!fits("5xl") && (e.before !== null || e.after !== null))) && (
                    <div className="mt-1 grid gap-1 text-xs">
                      {!fits("5xl") && <BeforeAfter entry={e} />}
                      {!fits("2xl") && (
                        <span className="flex flex-wrap gap-x-3 text-muted-foreground">
                          <span className="text-foreground">{e.actor.name}</span>
                          {!fits("xl") && <Time iso={e.occurredAt} />}
                        </span>
                      )}
                    </div>
                  )}
                </TableCell>
                <TableCell className="overflow-hidden px-0 font-mono text-xs whitespace-normal [overflow-wrap:anywhere] @5xl:px-2">
                  {fits("5xl") && <BeforeAfter entry={e} />}
                </TableCell>
                <TableCell className="pr-4 text-right @7xl:text-left">
                  {promoted.has(e.id) ? (
                    <span className="text-xs text-muted-foreground">On the Timeline</span>
                  ) : (
                    c?.status !== "closed" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        // Quiet until the row is pointed at or focused, so one button per row doesn't drown the record.
                        className={QUIET_ACTION}
                        aria-label="Promote to Timeline"
                        onClick={() => setPromoting(e)}
                      >
                        Promote
                      </Button>
                    )
                  )}
                </TableCell>
              </TableRow>
            ))}
            {entries.isError && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="px-4 whitespace-normal">
                  <span className="text-destructive">The Audit Log couldn't be loaded.</span>{" "}
                  <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void entries.refetch()}>
                    Try again
                  </Button>
                </TableCell>
              </TableRow>
            )}
            {entries.data?.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="px-4 text-muted-foreground">
                  {filtered ? "No entries match these filters." : "Nothing recorded yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
      {promoting && (
        <PromoteDialog
          number={number}
          source={{ kind: "audit_log_entry", id: promoting.id }}
          occurredAt={promoting.occurredAt}
          body={entryText(promoting)}
          onClose={() => setPromoting(null)}
        />
      )}
    </div>
  );
}
