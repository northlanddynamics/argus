import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { ClockIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { RichTextEditor } from "@/components/rich-text-editor";
import { PersonAvatar } from "@/components/presence-avatars";
import { Time } from "@/components/time";
import { InternalBadge, useActiveGuestNames } from "@/components/visibility";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { api, errorMessage } from "@/lib/api";
import { type CaseSummary, type CaseView, canParticipate, caseKey, caseQuery, casesKey, isReadOnly } from "@/lib/cases";
import { discussionQuery, messageParts } from "@/lib/discussion";
import { namesOf } from "@/lib/guests";
import { assetsQuery, observablesQuery } from "@/lib/observables";
import { describeOccurredAt, timelineQuery } from "@/lib/timeline";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { CaseAlertsPanel } from "@/routes/cases/alerts-panel";
import { RelatedAlertsPrompt } from "@/routes/cases/related-alerts-panel";
import { CaseRolesPanel } from "@/routes/cases/case-roles-panel";
import { LinkedCasesPanel } from "@/routes/cases/linked-cases-panel";
import { RailBody, RailHeader, RailSection, RailTitle } from "@/routes/cases/rail";
import { TagsPanel } from "@/routes/cases/tags-panel";
import { TaskDialog } from "@/routes/cases/task-dialog";
import { byUrgency, tasksKey, tasksQuery } from "@/lib/tasks";
import { instant } from "@/lib/when";
import { cn } from "@/lib/utils";

type Summary = CaseView["summary"];

/** What is being edited: the text and the version it started from. */
type Draft = { content: CaseSummary; version: number };

const when = instant;

/** How many open Tasks the Overview lists before pointing to the Tasks tab. */
const OPEN_TASKS_SHOWN = 5;

/** How many Timeline Entries and Discussion messages the Overview's Latest activity shows. */
const ACTIVITY_SHOWN = 5;

/**
 * Case · Overview: a working brief. The main column answers what an Analyst asks on opening a Case, in
 * that order: are there Alerts waiting to be attached, what needs doing next, what the Case is about,
 * and what has happened lately. The Case's record-keeping (its Alerts, scope, access, Case Roles,
 * links and Tags) sits in a quiet rail beside it, or under it when the page is narrow.
 */
export function CaseOverviewPage() {
  const number = useCaseNumber();
  const { data: c } = useQuery(caseQuery(number));
  if (!c) return null;
  /** Guests see neither who holds Case Roles nor the Cases this one is linked to. */
  const member = c.can.work;
  return (
    <div className="@container">
      <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_20rem] @[96rem]:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="grid min-w-0 gap-4">
          <RelatedAlertsPrompt c={c} />
          <OpenTasksCard c={c} />
          <CaseSummaryCard number={number} summary={c.summary} readOnly={isReadOnly(c)} />
          <LatestActivityCard number={number} />
        </div>
        <Card className="gap-0 divide-y py-1" aria-label="Case properties" role="complementary">
          <CaseAlertsPanel c={c} />
          <ScopeSection number={number} />
          {member && <AccessSection c={c} />}
          {member && <CaseRolesPanel number={number} caseRoles={c.caseRoles} readOnly={isReadOnly(c)} />}
          {member && <LinkedCasesPanel number={number} readOnly={isReadOnly(c)} />}
          <TagsPanel number={number} tags={c.tags} readOnly={isReadOnly(c)} />
        </Card>
      </div>
    </div>
  );
}

/** How many Observables and Assets the Case has, and the hosts Falcon has contained. */
function ScopeSection({ number }: { number: number }) {
  const observables = useQuery(observablesQuery(number));
  const assets = useQuery(assetsQuery(number));
  if (observables.isPending || assets.isPending) return null;
  const o = observables.data?.length ?? 0;
  const a = assets.data?.length ?? 0;
  /** Hosts with a device that isn't in normal containment, with what Falcon says of it. */
  const contained = (assets.data ?? []).flatMap((asset) =>
    asset.falcon
      .flatMap((v) => v.devices)
      .filter((d) => d.containment && d.containment !== "normal")
      .slice(0, 1)
      .map((d) => ({ id: asset.id, value: asset.value, containment: d.containment! })),
  );
  const containmentText = { contained: "Contained", containment_pending: "Containing", lift_containment_pending: "Lifting" } as const;
  const params = { number: String(number) };
  return (
    <RailSection>
      <RailHeader>
        <RailTitle>Scope</RailTitle>
        <Button variant="link" size="xs" className="h-auto px-0" asChild>
          <Link to="/cases/$number/observables" params={params}>
            Observables &amp; Assets
          </Link>
        </Button>
      </RailHeader>
      <RailBody>
        <p>
          {o} {o === 1 ? "Observable" : "Observables"} · {a} {a === 1 ? "Asset" : "Assets"}
        </p>
        {contained.length > 0 && (
          <ul className="grid gap-1" aria-label="Contained hosts">
            {contained.map((h) => (
              <li key={h.id} className="flex min-w-0 items-center justify-between gap-2">
                <span className="truncate font-mono text-xs" title={h.value}>
                  {h.value}
                </span>
                <Badge variant="outline">{containmentText[h.containment as keyof typeof containmentText]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </RailBody>
    </RailSection>
  );
}

/** Who can see the Case: every Member or only some (Restricted), and its Guests. Changed from Access in the header. */
function AccessSection({ c }: { c: CaseView }) {
  const guests = useActiveGuestNames(c.number, true);
  return (
    <RailSection>
      <RailHeader>
        <RailTitle>Access</RailTitle>
      </RailHeader>
      <RailBody>
        <p>
          {c.restricted ? "Restricted" : "Every Member"}
          {" · "}
          {guests.length ? (
            <>
              {guests.length} {guests.length === 1 ? "Guest" : "Guests"} <span className="text-muted-foreground">({namesOf(guests)})</span>
            </>
          ) : (
            <span className="text-muted-foreground">no Guests</span>
          )}
        </p>
      </RailBody>
    </RailSection>
  );
}

/**
 * The open Tasks, most urgent first, each ticked off in place: the Case's next actions, on the page
 * Analysts land on. "Mine" narrows them to the viewer's own.
 */
function OpenTasksCard({ c }: { c: CaseView }) {
  const { me } = useRouteContext({ from: "/_app/cases/$number" });
  const number = c.number;
  const queryClient = useQueryClient();
  const tasks = useQuery(tasksQuery(number));
  const [mine, setMine] = useState(false);
  const [adding, setAdding] = useState(false);
  const setDone = useMutation({
    mutationFn: async ({ id, done }: { id: string; done: boolean }) => {
      const res = await api.cases[":number"].tasks[":id"].done.$put({ param: { number: String(number), id }, json: { done } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not change the Task"));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tasksKey(number) });
      void queryClient.invalidateQueries({ queryKey: caseKey(number), exact: true });
    },
  });
  const open = (tasks.data ?? []).filter((t) => !t.done).toSorted(byUrgency);
  const shown = mine ? open.filter((t) => t.owner.id === me.user.id) : open;
  const overdue = open.filter((t) => t.overdue).length;
  const params = { number: String(number) };
  const participating = canParticipate(c);
  return (
    <Card size="sm" className="@container">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-x-2">
          <h2>Open Tasks</h2>
          {!tasks.isPending && (
            <span className="text-xs font-normal text-muted-foreground">
              {open.length} open{overdue > 0 && ` · ${overdue} overdue`}
            </span>
          )}
        </CardTitle>
        <CardAction className="flex items-center gap-3">
          <div className="flex rounded-lg bg-muted p-0.5" role="group" aria-label="Whose Tasks">
            {[false, true].map((value) => (
              <Button
                key={String(value)}
                variant="ghost"
                size="xs"
                aria-pressed={mine === value}
                className={cn("h-6 rounded-md px-2", mine === value ? "bg-background shadow-xs hover:bg-background" : "text-muted-foreground")}
                onClick={() => setMine(value)}
              >
                {value ? "Mine" : "All"}
              </Button>
            ))}
          </div>
          <Button variant="link" size="sm" className="h-auto px-0" asChild>
            <Link to="/cases/$number/tasks" params={params}>
              All Tasks
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-2">
        {setDone.error && (
          <Alert variant="destructive">
            <AlertDescription>{setDone.error.message}</AlertDescription>
          </Alert>
        )}
        {tasks.isPending ? null : shown.length === 0 ? (
          <p className="text-muted-foreground">{mine ? "None of the open Tasks are yours." : "No open Tasks."}</p>
        ) : (
          <ul className="grid divide-y" aria-label="Open Tasks">
            {shown.slice(0, OPEN_TASKS_SHOWN).map((t) => (
              <li key={t.id} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                <Checkbox
                  className="mt-0.5"
                  aria-label={`${t.title} done`}
                  checked={false}
                  disabled={!participating || setDone.isPending}
                  onCheckedChange={(checked) => setDone.mutate({ id: t.id, done: checked === true })}
                />
                {/* Titles wrap rather than truncate; owner and due date drop below when the card is narrow. */}
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="flex min-w-48 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-medium">{t.title}</span>
                    {t.internal && <InternalBadge />}
                  </span>
                  <span className="shrink-0 truncate @xl:w-36" title={t.owner.name}>
                    {t.owner.id === me.user.id ? "You" : t.owner.name}
                  </span>
                  <span className="shrink-0 tabular-nums @xl:w-40 @xl:text-right">
                    {t.overdue ? (
                      <Badge variant="outline" className="border-overdue-border text-overdue">
                        Overdue · {t.dueDate}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">{t.dueDate ? `Due ${t.dueDate}` : "No due date"}</span>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {(shown.length > OPEN_TASKS_SHOWN || !isReadOnly(c)) && (
          <div className="flex items-center gap-2 border-t pt-2">
            {!isReadOnly(c) && (
              <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setAdding(true)}>
                <PlusIcon aria-hidden />
                New Task
              </Button>
            )}
            {shown.length > OPEN_TASKS_SHOWN && (
              <span className="ml-auto text-muted-foreground">and {shown.length - OPEN_TASKS_SHOWN} more on the Tasks tab</span>
            )}
          </div>
        )}
      </CardContent>
      {adding && <TaskDialog key="new" number={number} task={null} defaultOwnerId={me.user.id} onClose={() => setAdding(false)} />}
    </Card>
  );
}

/**
 * The newest Timeline Entries and Discussion messages together, newest first by when they were added,
 * so what changed since the last visit shows without leaving the Overview. Retracted ones are left out.
 */
function LatestActivityCard({ number }: { number: number }) {
  const timeline = useQuery(timelineQuery(number));
  const discussion = useQuery(discussionQuery(number));
  const params = { number: String(number) };
  if (timeline.isPending || discussion.isPending) return null;
  const items = [
    ...(timeline.data ?? []).filter((e) => !e.retracted).map((e) => ({ kind: "entry" as const, at: e.recordedAt, entry: e })),
    ...(discussion.data ?? []).filter((m) => m.body !== null).map((m) => ({ kind: "message" as const, at: m.postedAt, message: m })),
  ]
    .toSorted((a, b) => b.at.localeCompare(a.at))
    .slice(0, ACTIVITY_SHOWN);
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>Latest activity</h2>
        </CardTitle>
        <CardAction>
          <Button variant="link" size="sm" className="h-auto px-0" asChild>
            <Link to="/cases/$number/timeline" params={params}>
              Timeline &amp; Discussion
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-muted-foreground">Nothing on the Timeline or in the Discussion yet.</p>
        ) : (
          <ol className="grid divide-y" aria-label="Latest activity">
            {items.map((item) =>
              item.kind === "entry" ? (
                <li key={`e-${item.entry.id}`} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2.5 py-2 first:pt-0 last:pb-0">
                  <span className="flex size-6 items-center justify-center rounded-full border text-muted-foreground">
                    <ClockIcon aria-hidden className="size-3" />
                  </span>
                  <div className="grid gap-0.5">
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      <span className="font-medium">Timeline</span>
                      <span className="text-xs text-muted-foreground">· {describeOccurredAt(item.entry.occurredAt)}</span>
                      {item.entry.internal && <InternalBadge />}
                    </span>
                    <p className="line-clamp-2 wrap-break-word">{item.entry.body}</p>
                  </div>
                </li>
              ) : (
                <li key={`m-${item.message.id}`} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2.5 py-2 first:pt-0 last:pb-0">
                  <span className="flex size-6 items-center justify-center">
                    <PersonAvatar person={item.message.author} />
                  </span>
                  <div className="grid gap-0.5">
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      <span className="font-medium">{item.message.author.name}</span>
                      <span className="text-xs text-muted-foreground">
                        · Discussion · <Time iso={item.message.postedAt} />
                      </span>
                      {item.message.internal && <InternalBadge />}
                    </span>
                    <p className="line-clamp-2 wrap-break-word">
                      {messageParts(item.message.body ?? "", item.message.mentions).map((part, i) =>
                        typeof part === "string" ? (
                          part
                        ) : (
                          <span key={i} className="rounded bg-mention px-0.5 font-medium text-mention-foreground">
                            @{part.name}
                          </span>
                        ),
                      )}
                    </p>
                  </div>
                </li>
              ),
            )}
          </ol>
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
      <Card size="sm">
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
        <Card size="sm">
          <CardHeader>
            <CardTitle>
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
