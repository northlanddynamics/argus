import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { caseQuery, isReadOnly } from "@/lib/cases";
import { describeOccurredAt, occurredKindLabel, precisionLabel, type TimelineEntryView, timelineKey, timelineQuery, utc } from "@/lib/timeline";
import { actionLabel } from "@/routes/cases/audit-log";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { CaseDiscussion } from "@/routes/cases/discussion";
import { EditEntryForm, NewEntryForm } from "@/routes/cases/timeline-entry-form";

/** Case · Timeline & Discussion: the account of what happened, beside the conversation about it. */
export function CaseTimelinePage() {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
      <CaseTimeline />
      <CaseDiscussion />
    </div>
  );
}

/** The Timeline: Timeline Entries ordered by when things happened in the real world. */
function CaseTimeline() {
  const number = useCaseNumber();
  const { data: c } = useQuery(caseQuery(number));
  const entries = useQuery(timelineQuery(number));
  const [editing, setEditing] = useState<string | null>(null);
  if (!c) return null;
  const readOnly = isReadOnly(c);
  return (
    <section className="grid gap-4" aria-label="Timeline">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <span className="text-xs text-muted-foreground">Ordered by when it happened · times in UTC</span>
      </div>
      {!readOnly && (
        <Card>
          <CardHeader className="flex-row items-baseline justify-between">
            <CardTitle>New Timeline Entry</CardTitle>
            <span className="text-xs text-muted-foreground">Recorded-at is set automatically</span>
          </CardHeader>
          <CardContent>
            <NewEntryForm number={number} />
          </CardContent>
        </Card>
      )}
      <ol className="grid gap-3" aria-label="Timeline Entries">
        {entries.data?.map((e) => (
          <li key={e.id} aria-label={`Timeline Entry: ${e.body}`}>
            <Card>
              <CardContent>
                {editing === e.id ? (
                  <EditEntryForm number={number} entry={e} onDone={() => setEditing(null)} />
                ) : (
                  <Entry number={number} entry={e} readOnly={readOnly} onEdit={() => setEditing(e.id)} />
                )}
              </CardContent>
            </Card>
          </li>
        ))}
        {entries.data?.length === 0 && <li className="text-sm text-muted-foreground">Nothing on the Timeline yet.</li>}
      </ol>
    </section>
  );
}

const sourceText = (source: NonNullable<TimelineEntryView["source"]>) =>
  source.kind === "discussion_message"
    ? `Promoted from Discussion message by ${source.author.name}`
    : `Promoted from Audit Log (${actionLabel[source.action] ?? source.action} by ${source.actor})`;

function Entry({ number, entry: e, readOnly, onEdit }: { number: number; entry: TimelineEntryView; readOnly: boolean; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
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
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{describeOccurredAt(o)}</h3>
        <Badge variant="outline">{o.kind === "approximate" ? `Approximate ${precisionLabel(o.precisionMinutes)}` : occurredKindLabel[o.kind]}</Badge>
        {!readOnly && live && (
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={onEdit}>
              Edit
            </Button>
            {!confirming && (
              <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                Retract
              </Button>
            )}
          </div>
        )}
      </div>
      <p className={`text-sm whitespace-pre-wrap ${live ? "" : "text-muted-foreground line-through"}`}>{e.body}</p>
      {e.citations.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Cites">
          {e.citations.map((c) => (
            <li key={`${c.kind}:${c.id}`}>
              <Badge variant="secondary">{c.label.replace(/^Task: /, "Task · ")}</Badge>
            </li>
          ))}
        </ul>
      )}
      {e.retracted ? (
        <p className="text-xs text-muted-foreground">
          Retracted by {e.retracted.by.name}
          {e.retracted.reason && ` — ${e.retracted.reason}`}. Original kept in the Audit Log.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Recorded {utc(e.recordedAt)} by {e.recordedBy.name}
          {e.source && ` · ${sourceText(e.source)}`}
          {e.editedAt && " · edited (original in Audit Log)"}
        </p>
      )}
      {confirming && live && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            retract.mutate(undefined, { onSuccess: () => setConfirming(false) });
          }}
        >
          <Input
            aria-label="Why retract it? (optional)"
            placeholder="Why? (optional)"
            className="max-w-xs"
            maxLength={500}
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
          />
          <Button type="submit" variant="destructive" size="sm" disabled={retract.isPending}>
            Retract entry
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </form>
      )}
      {retract.error && (
        <Alert variant="destructive">
          <AlertDescription>{retract.error.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
