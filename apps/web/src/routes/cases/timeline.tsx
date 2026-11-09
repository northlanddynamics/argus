import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { Visibility } from "@/components/visibility";
import { canMarkInternal, caseQuery, isReadOnly } from "@/lib/cases";
import { type OccurredAt, precisionLabel, type TimelineEntryView, timelineKey, timelineQuery, utc } from "@/lib/timeline";
import { actionLabel } from "@/routes/cases/audit-log";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { CaseDiscussion } from "@/routes/cases/discussion";
import { cn, REVEAL } from "@/lib/utils";
import { EditEntryForm, NewEntryForm } from "@/routes/cases/timeline-entry-form";

/** Case · Timeline & Discussion: the account of what happened, beside the conversation about it. */
export function CaseTimelinePage() {
  return (
    <div className="grid gap-4">
      {/* Side by side only where both columns have room; below that the Timeline sits above the Discussion.
          The pair stops at 112rem, so on a very wide page entries and messages keep a readable width and
          their actions stay beside them. */}
      <div className="grid max-w-[112rem] items-start gap-4 @5xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <CaseTimeline />
        <CaseDiscussion />
      </div>
    </div>
  );
}

/** The UTC day a Timeline Entry happened on (its start, for a range): the Timeline groups by it. */
const dayOf = (o: OccurredAt) => (o.kind === "range" ? o.start : o.at).slice(0, 10);

/** "Tue 28 Oct 2026": a day heading, in UTC as every Timeline time is. */
const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Words only screen readers read. */
const hidden = (text: string) => <span className="sr-only">{text}</span>;

/** "09:14": the time of a UTC instant. */
const time = (iso: string) => iso.slice(11, 16);

/**
 * When an entry happened, in the row's time column. The day is already the group's heading, so it is
 * shown only to screen readers, which read the whole of `describeOccurredAt` ("2026-10-28 09:14 UTC").
 * Exact times say nothing more; an approximate time says how far off it may be, a range where it ends.
 */
function OccurredCell({ o }: { o: OccurredAt }) {
  switch (o.kind) {
    case "exact":
      return (
        <h3 className="font-medium tabular-nums">
          {hidden(`${o.at.slice(0, 10)} `)}
          {time(o.at)}
          {hidden(" UTC")}
        </h3>
      );
    case "range": {
      const sameDay = o.start.slice(0, 10) === o.end.slice(0, 10);
      return (
        <h3 className="font-medium tabular-nums">
          {hidden(`${o.start.slice(0, 10)} `)}
          {time(o.start)}
          {sameDay ? (
            <>
              {` → ${time(o.end)}`}
              {hidden(" UTC")}
            </>
          ) : (
            <>
              {hidden(" UTC")}
              {" → "}
              {hidden(o.end.slice(0, 5))}
              {`${o.end.slice(5, 10)} ${time(o.end)}`}
              {hidden(" UTC")}
            </>
          )}
        </h3>
      );
    }
    case "approximate":
      return (
        <h3 className="grid font-medium tabular-nums">
          <span>
            ≈ {hidden(`${o.at.slice(0, 10)} `)}
            {time(o.at)}
            {hidden(" UTC ")}
          </span>
          <span className="text-xs font-normal text-muted-foreground">{precisionLabel(o.precisionMinutes)}</span>
        </h3>
      );
  }
}

/**
 * The Timeline: Timeline Entries ordered by when things happened in the real world, as rows in one
 * card grouped by day, with the time in its own column so the account reads straight down.
 */
function CaseTimeline() {
  const number = useCaseNumber();
  const { data: c } = useQuery(caseQuery(number));
  const entries = useQuery(timelineQuery(number));
  const [editing, setEditing] = useState<string | null>(null);
  /** The new-entry form opens on demand, so the Timeline itself leads the page. */
  const [composing, setComposing] = useState(false);
  if (!c) return null;
  const readOnly = isReadOnly(c);
  const list = entries.data ?? [];
  return (
    <section className="min-w-0" aria-label="Timeline">
      <Card size="sm" className="gap-0 pb-0">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-baseline gap-x-2">
            <h2>Timeline</h2>
            {list.length > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                {list.length} {list.length === 1 ? "entry" : "entries"} · times in UTC
              </span>
            )}
          </CardTitle>
          {!readOnly && !composing && (
            <CardAction>
              <Button variant="outline" size="sm" onClick={() => setComposing(true)}>
                + Timeline Entry
              </Button>
            </CardAction>
          )}
        </CardHeader>
        {!readOnly && composing && (
          <div className="grid gap-3 border-t px-3 py-3">
            <h3 className="font-medium">New Timeline Entry</h3>
            <NewEntryForm number={number} onCancel={() => setComposing(false)} />
          </div>
        )}
        <ol className="grid grid-cols-1" aria-label="Timeline Entries">
          {list.map((e, i) => (
            <Fragment key={e.id}>
              {(i === 0 || dayOf(list[i - 1]!.occurredAt) !== dayOf(e.occurredAt)) && (
                <li aria-hidden className="border-t bg-muted/50 px-3 pt-2.5 pb-1.5 text-xs font-medium text-muted-foreground">
                  {dayLabel(dayOf(e.occurredAt))}
                </li>
              )}
              <li aria-label={`Timeline Entry: ${e.body}`} className="group/row relative min-w-0 border-t px-3 py-2.5">
                {editing === e.id ? (
                  <EditEntryForm number={number} entry={e} onDone={() => setEditing(null)} />
                ) : (
                  <Entry number={number} entry={e} readOnly={readOnly} canMark={canMarkInternal(c)} onEdit={() => setEditing(e.id)} />
                )}
              </li>
            </Fragment>
          ))}
          {entries.data?.length === 0 && <li className="border-t px-3 py-3 text-muted-foreground">Nothing on the Timeline yet.</li>}
        </ol>
      </Card>
    </section>
  );
}

const sourceText = (source: NonNullable<TimelineEntryView["source"]>) =>
  source.kind === "discussion_message"
    ? `Promoted from Discussion message by ${source.author.name}`
    : `Promoted from Audit Log (${actionLabel[source.action] ?? source.action} by ${source.actor})`;

function Entry({
  number,
  entry: e,
  readOnly,
  canMark,
  onEdit,
}: {
  number: number;
  entry: TimelineEntryView;
  readOnly: boolean;
  canMark: boolean;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const retract = useMutation({
    mutationFn: async () => {
      const res = await api.cases[":number"].timeline[":id"].retract.$post({
        param: { number: String(number), id: e.id },
        json: { reason: reason.trim() || null },
      });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not retract the entry"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: timelineKey(number) }),
  });
  const o = e.occurredAt;
  const live = !e.retracted;
  const label = `entry “${e.body.slice(0, 40)}”`;
  return (
    <div className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3">
      <OccurredCell o={o} />
      <div className="grid min-w-0 gap-1">
        <p className={`text-sm wrap-break-word whitespace-pre-wrap ${live ? "" : "text-muted-foreground line-through"}`}>{e.body}</p>
        {e.citations.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Cites">
            {e.citations.map((c) => (
              <li key={`${c.kind}:${c.id}`} className="min-w-0 max-w-full">
                <Badge variant="secondary" className="max-w-full" title={c.label}>
                  <span className="truncate">{c.label.replace(/^Task: /, "Task · ")}</span>
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {/* Who recorded it, and Internal when it is hidden from Guests. */}
        <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
          {e.retracted ? (
            <p className="min-w-0 text-xs wrap-break-word text-muted-foreground">
              Retracted by {e.retracted.by.name}
              {e.retracted.reason && ` — ${e.retracted.reason}`}.
            </p>
          ) : (
            <p className="min-w-0 text-xs wrap-break-word text-muted-foreground">
              Recorded {utc(e.recordedAt)} by {e.recordedBy.name}
              {e.source && ` · ${sourceText(e.source)}`}
              {e.editedAt && " · edited"}
            </p>
          )}
          {e.internal && (
            <Visibility number={number} item={{ kind: "timeline_entry", id: e.id }} internal label={label} canMark={canMark && live} />
          )}
        </div>
        {retract.error && (
          <Alert variant="destructive">
            <AlertDescription>{retract.error.message}</AlertDescription>
          </Alert>
        )}
      </div>
      {/* What can be done to the entry floats over the end of its first line when the row is pointed
          at or focused, so it takes no room of its own. */}
      {live && ((!e.internal && canMark) || !readOnly) && (
        <div className={cn("absolute top-2 right-2 flex items-center gap-1 rounded-md bg-card pl-2", REVEAL)}>
          {!e.internal && canMark && <Visibility number={number} item={{ kind: "timeline_entry", id: e.id }} internal={false} label={label} canMark />}
          {!readOnly && (
            <>
              <Button variant="ghost" size="xs" onClick={onEdit}>
                Edit
              </Button>
              <AlertDialog
                onOpenChange={(open) => {
                  if (!open) return;
                  setReason("");
                  retract.reset();
                }}
              >
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="xs">
                    Retract
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Retract this Timeline Entry?</AlertDialogTitle>
                    <AlertDialogDescription>It stays on the Timeline struck through.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <Field>
                    <FieldLabel htmlFor={`retract-${e.id}`}>Why retract it? (optional)</FieldLabel>
                    <Input id={`retract-${e.id}`} maxLength={500} value={reason} onChange={(ev) => setReason(ev.target.value)} />
                  </Field>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep it</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" disabled={retract.isPending} onClick={() => retract.mutate()}>
                      Retract entry
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </div>
      )}
    </div>
  );
}
