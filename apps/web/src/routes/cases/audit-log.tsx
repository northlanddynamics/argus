import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { promotedSources, timelineQuery } from "@/lib/timeline";
import { useCaseNumber } from "@/routes/cases/case-layout";
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
  "observable.linked": "Added Observable",
  "observable.unlinked": "Unlinked Observable",
  "asset.linked": "Added Asset",
  "asset.unlinked": "Unlinked Asset",
  "case_link.added": "Linked Case",
  "case_link.removed": "Unlinked Case",
  "tag.added": "Added Tag",
  "tag.removed": "Removed Tag",
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

type Entry = { id: string; occurredAt: string; action: CaseAuditAction; target: string | null; before: string | null; after: string | null };

/** An entry in words, as the starting text of a Timeline Entry Promoted from it. */
const entryText = (e: Entry) => {
  const what = `${actionLabel[e.action] ?? e.action}${e.target === null ? "" : ` ${e.target}`}`;
  if (e.before === null && e.after === null) return what;
  const change = e.before === null ? shown(e.action, e.after) : `${shown(e.action, e.before)} → ${shown(e.action, e.after)}`;
  return `${what}: ${change}`;
};

export function CaseAuditLogPage() {
  const number = useCaseNumber();
  const { data: c } = useQuery(caseQuery(number));
  const timeline = useQuery(timelineQuery(number));
  const promoted = promotedSources(timeline.data);
  const [promoting, setPromoting] = useState<Entry | null>(null);
  const [actor, setActor] = useState("");
  const [action, setAction] = useState<CaseAuditAction | "">("");
  const [from, setFrom] = useState("");

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

  return (
    <>
      <Card>
        <CardContent className="grid gap-4 sm:grid-cols-[1fr_1fr_1fr_2fr] sm:items-end">
          <div className="grid gap-2">
            <Label htmlFor="audit-actor">Actor</Label>
            <NativeSelect id="audit-actor" value={actor} onChange={(e) => setActor(e.target.value)}>
              <NativeSelectOption value="">Anyone</NativeSelectOption>
              {members.data?.members.map((m) => (
                <NativeSelectOption key={m.userId} value={m.userId}>
                  {m.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="audit-action">Action</Label>
            <NativeSelect id="audit-action" value={action} onChange={(e) => setAction(e.target.value as CaseAuditAction | "")}>
              <NativeSelectOption value="">All actions</NativeSelectOption>
              {CASE_AUDIT_ACTIONS.map((a) => (
                <NativeSelectOption key={a} value={a}>
                  {actionLabel[a]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="audit-from">From</Label>
            <Input id="audit-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <p className="text-right text-xs text-muted-foreground">Immutable · system-written · ordered by when it was done in Argus</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Before → After</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.data?.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs">{new Date(e.occurredAt).toLocaleString()}</TableCell>
                  <TableCell>{e.actor.name}</TableCell>
                  <TableCell>
                    {actionLabel[e.action] ?? e.action}
                    {e.target !== null && <span className="font-medium"> {e.target}</span>}
                  </TableCell>
                  <TableCell className="max-w-md font-mono text-xs whitespace-normal">
                    {e.before !== null && <span className="line-through">{shown(e.action, e.before)}</span>}
                    {e.before !== null && " "}→ {shown(e.action, e.after)}
                  </TableCell>
                  <TableCell className="text-right">
                    {promoted.has(e.id) ? (
                      <span className="text-xs text-muted-foreground">On the Timeline</span>
                    ) : (
                      c?.status !== "closed" && (
                        <Button variant="outline" size="sm" onClick={() => setPromoting(e)}>
                          Promote to Timeline
                        </Button>
                      )
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {entries.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    Nothing matches.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
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
    </>
  );
}
