import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { RichTextEditor } from "@/components/rich-text-editor";
import { InternalBadge } from "@/components/visibility";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";
import { type CaseSummary, type CaseView, caseKey, caseQuery, casesKey, resolutionLabel, isReadOnly } from "@/lib/cases";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { CaseAlertsPanel } from "@/routes/cases/alerts-panel";
import { RelatedAlertsPanel } from "@/routes/cases/related-alerts-panel";
import { CaseRolesPanel } from "@/routes/cases/case-roles-panel";
import { LinkedCasesPanel } from "@/routes/cases/linked-cases-panel";
import { RailBody, RailHeader, RailSection, RailTitle } from "@/routes/cases/rail";
import { TagsPanel } from "@/routes/cases/tags-panel";
import { type TaskView, tasksQuery } from "@/lib/tasks";
import { instant } from "@/lib/when";

type Summary = CaseView["summary"];

/** What is being edited: the text and the version it started from. */
type Draft = { content: CaseSummary; version: number };

const when = instant;

/** How many open Tasks the Overview lists before pointing to the Tasks tab. */
const OPEN_TASKS_SHOWN = 5;

/**
 * Case · Overview: what the Case is about and what needs doing next, with its details, links and
 * Tags in the rail beside it.
 */
export function CaseOverviewPage() {
  const number = useCaseNumber();
  const { data: c } = useQuery(caseQuery(number));
  if (!c) return null;
  /** Guests see neither who holds Case Roles nor the Cases this one is linked to. */
  const member = c.can.work;
  // On a very wide page the Summary and the open Tasks sit side by side; below 104rem the Tasks would be cut short, so they stack.
  return (
    <div className="@container">
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px] @[104rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_300px]">
        <div className="grid min-w-0 content-start gap-4 @[104rem]:contents">
          <CaseSummaryCard number={number} summary={c.summary} readOnly={isReadOnly(c)} />
          <OpenTasksCard number={number} />
        </div>
        <Card className="gap-0 divide-y py-1">
          <RailSection>
            <RailHeader>
              <RailTitle>Details</RailTitle>
            </RailHeader>
            <RailBody>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Opened</dt>
                <dd>
                  {when(c.openedAt)}
                  <span className="block text-muted-foreground">by {c.openedBy.name}</span>
                </dd>
                <dt className="text-muted-foreground">Updated</dt>
                <dd>{when(c.updatedAt)}</dd>
                {c.closed && c.resolution && (
                  <>
                    <dt className="text-muted-foreground">Closed</dt>
                    <dd>
                      {when(c.closed.at)}
                      <span className="block text-muted-foreground">by {c.closed.by.name}</span>
                    </dd>
                    <dt className="text-muted-foreground">Resolution</dt>
                    <dd>{resolutionLabel[c.resolution]}</dd>
                  </>
                )}
              </dl>
            </RailBody>
          </RailSection>
          {member && <CaseRolesPanel number={number} caseRoles={c.caseRoles} readOnly={isReadOnly(c)} />}
          <CaseAlertsPanel c={c} />
          <RelatedAlertsPanel c={c} />
          {member && <LinkedCasesPanel number={number} readOnly={isReadOnly(c)} />}
          <TagsPanel number={number} tags={c.tags} readOnly={isReadOnly(c)} />
        </Card>
      </div>
    </div>
  );
}

/** Overdue first, then by due date (none last), then as listed. */
const byUrgency = (a: TaskView, b: TaskView) =>
  Number(b.overdue) - Number(a.overdue) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");

/** The open Tasks, most urgent first: the Case's next actions, on the page Analysts land on. */
function OpenTasksCard({ number }: { number: number }) {
  const tasks = useQuery(tasksQuery(number));
  const open = (tasks.data ?? []).filter((t) => !t.done).toSorted(byUrgency);
  const params = { number: String(number) };
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>Open Tasks</h2>
        </CardTitle>
        <CardAction>
          <Button variant="link" size="sm" className="h-auto px-0" asChild>
            <Link to="/cases/$number/tasks" params={params}>
              All Tasks
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {tasks.isPending ? null : open.length === 0 ? (
          <p className="text-muted-foreground">No open Tasks.</p>
        ) : (
          <ul className="grid divide-y" aria-label="Open Tasks">
            {open.slice(0, OPEN_TASKS_SHOWN).map((t) => (
              <li key={t.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 first:pt-0 last:pb-0">
                {/* Titles wrap rather than truncate; owner and due date drop below when the card is narrow. */}
                <span className="flex min-w-48 flex-1 items-baseline gap-2">
                  <span className="font-medium">{t.title}</span>
                  {t.internal && <InternalBadge />}
                </span>
                <span className="shrink-0 text-muted-foreground">{t.owner.name}</span>
                <span className="min-w-32 shrink-0 text-right tabular-nums">
                  {t.overdue ? (
                    <Badge variant="outline" className="border-overdue-border text-overdue">
                      Overdue · {t.dueDate}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">{t.dueDate ? `Due ${t.dueDate}` : "No due date"}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {open.length > OPEN_TASKS_SHOWN && (
          <p className="mt-2 text-muted-foreground">and {open.length - OPEN_TASKS_SHOWN} more on the Tasks tab.</p>
        )}
      </CardContent>
    </Card>
  );
}

function CaseSummaryCard({ number, summary, readOnly }: { number: number; summary: Summary; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The newer version a refused save ran into. */
  const [conflict, setConflict] = useState<Summary | null>(null);
  /** The Member's own text, set aside after loading the current version. */
  const [setAside, setSetAside] = useState<CaseSummary | null>(null);
  const [showCurrent, setShowCurrent] = useState(false);

  const save = useMutation({
    mutationFn: async ({ content, version }: Draft) => {
      const res = await api.cases[":number"].summary.$put({ param: { number: String(number) }, json: { summary: content, version } });
      if (res.status === 409) {
        const body = await res.json();
        // A newer version carries `current`; a Closed Case refuses with only an error.
        if ("current" in body) return { kind: "conflict", current: body.current as Summary } as const;
        throw new Error(body.error);
      }
      if (!res.ok) throw new Error(await errorMessage(res, "Could not save the Case Summary"));
      const body = await res.json();
      if (!("summary" in body)) throw new Error("Could not save the Case Summary");
      return { kind: "saved", summary: body.summary } as const;
    },
    onSuccess: (result) => {
      if (result.kind === "conflict") {
        setConflict(result.current);
        setShowCurrent(false);
        return;
      }
      queryClient.setQueryData(caseKey(number), (c: CaseView | null | undefined) => (c ? { ...c, summary: result.summary } : c));
      void queryClient.invalidateQueries({ queryKey: casesKey });
      setDraft(null);
      setConflict(null);
      setSetAside(null);
    },
  });

  const loadCurrent = () => {
    if (!draft || !conflict) return;
    setSetAside(draft.content);
    setDraft({ content: conflict.content, version: conflict.version });
    queryClient.setQueryData(caseKey(number), (c: CaseView | null | undefined) => (c ? { ...c, summary: conflict } : c));
    setConflict(null);
  };

  const cancel = () => {
    setDraft(null);
    setConflict(null);
    setSetAside(null);
    save.reset();
  };

  return (
    <div className="grid content-start gap-4">
      {conflict && (
        <Alert className="border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80">
          <AlertTitle>Not saved — the Case Summary changed since you opened it</AlertTitle>
          <AlertDescription className="grid gap-3">
            <p>
              {conflict.updatedBy.name} saved a newer version (v{conflict.version}) at {when(conflict.updatedAt)}. Your text is kept
              below; review theirs before saving again.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowCurrent((s) => !s)}>
                {showCurrent ? "Hide current" : "Compare with current"}
              </Button>
              <Button variant="outline" size="sm" onClick={loadCurrent}>
                Load current, keep my draft aside
              </Button>
            </div>
            {showCurrent && (
              <RichTextEditor label="Current Case Summary" value={conflict.content} editable={false} className="rounded-md border bg-background p-3" />
            )}
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Case Summary</h2>
          </CardTitle>
          {/* Nothing to attribute until something has been written. */}
          {(summary.content.content.length > 0 || summary.version > 1) && (
            <CardDescription className="text-xs">
              Last saved by {summary.updatedBy.name} · v{summary.version}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="grid gap-4">
          {draft ? (
            <>
              <RichTextEditor label="Case Summary" value={draft.content} onChange={(content) => setDraft({ ...draft, content })} />
              {save.error && (
                <Alert variant="destructive">
                  <AlertDescription>{save.error.message}</AlertDescription>
                </Alert>
              )}
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button variant="outline" onClick={cancel}>
                  Cancel
                </Button>
                <Button onClick={() => save.mutate(draft)} disabled={save.isPending}>
                  Save
                </Button>
              </div>
            </>
          ) : (
            <>
              {summary.content.content.length ? (
                <RichTextEditor label="Case Summary" value={summary.content} editable={false} />
              ) : (
                <p className="text-sm text-muted-foreground">Nothing written yet.</p>
              )}
              {!readOnly && (
                <div className="flex justify-end">
                  <Button variant="outline" onClick={() => setDraft({ content: summary.content, version: summary.version })}>
                    Edit
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
      {setAside && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              <h2>Your draft, set aside</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RichTextEditor label="Your draft" value={setAside} editable={false} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
