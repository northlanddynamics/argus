import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { RichTextEditor } from "@/components/rich-text-editor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";
import { type CaseSummary, type CaseView, caseKey, caseQuery, casesKey, resolutionLabel, isReadOnly } from "@/lib/cases";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { CaseAlertsPanel } from "@/routes/cases/alerts-panel";
import { CaseRolesPanel } from "@/routes/cases/case-roles-panel";
import { GuestsPanel } from "@/routes/cases/guests-panel";
import { LinkedCasesPanel } from "@/routes/cases/linked-cases-panel";
import { TagsPanel } from "@/routes/cases/tags-panel";

type Summary = CaseView["summary"];

/** What is being edited: the text and the version it started from. */
type Draft = { content: CaseSummary; version: number };

const when = (iso: string) => new Date(iso).toLocaleString();

export function CaseOverviewPage() {
  const number = useCaseNumber();
  const { data: c } = useQuery(caseQuery(number));
  if (!c) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <CaseSummaryCard number={number} summary={c.summary} readOnly={isReadOnly(c)} />
      <div className="grid content-start gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-xs tracking-widest text-muted-foreground uppercase">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Opened</dt>
            <dd>
              {when(c.openedAt)} by {c.openedBy.name}
            </dd>
            <dt className="text-muted-foreground">Updated</dt>
            <dd>{when(c.updatedAt)}</dd>
            {c.closed && c.resolution && (
              <>
                <dt className="text-muted-foreground">Closed</dt>
                <dd>
                  {when(c.closed.at)} by {c.closed.by.name}
                </dd>
                <dt className="text-muted-foreground">Resolution</dt>
                <dd>{resolutionLabel[c.resolution]}</dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>
      <CaseRolesPanel number={number} caseRoles={c.caseRoles} readOnly={isReadOnly(c)} />
      {c.can.readAuditLog && <CaseAlertsPanel number={number} />}
      <LinkedCasesPanel number={number} readOnly={isReadOnly(c)} />
      <TagsPanel number={number} tags={c.tags} readOnly={isReadOnly(c)} />
      {c.can.work && <GuestsPanel c={c} />}
      </div>
    </div>
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
        <Alert className="border-amber-300 bg-amber-50 text-amber-950">
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
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Case Summary</CardTitle>
          <span className="text-xs text-muted-foreground">
            Last saved by {summary.updatedBy.name} · v{summary.version}
          </span>
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
            <CardTitle className="text-sm">Your draft, set aside</CardTitle>
          </CardHeader>
          <CardContent>
            <RichTextEditor label="Your draft" value={setAside} editable={false} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
