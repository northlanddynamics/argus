import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CaseRef } from "@/components/case-ref";
import { Time } from "@/components/time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { actionCenterKey, REASON_MAX_LENGTH } from "@/lib/action-center";
import { caseRef } from "@/lib/cases";
import { cn } from "@/lib/utils";
import {
  isFinished,
  refreshWorkflows,
  retryWorkflowRun,
  runWorkflow,
  type Workflow,
  type WorkflowRun,
  workflowRunQuery,
  type WorkflowRunState,
  workflowRunStateLabel,
  workflowsQuery,
} from "@/lib/workflows";
import { CasePicker } from "@/routes/alerts/alert-dialogs";

/** "Link to a Case": off for no Case, else the Case picked. */
export function CaseChoice({ value, onChange, required = false }: { value: number | null | undefined; onChange: (n: number | null | undefined) => void; required?: boolean }) {
  const on = required || value !== null;
  return (
    <div className="grid gap-2">
      {!required && (
        <Label className="flex items-center gap-2 font-normal">
          <Checkbox checked={on} onCheckedChange={(c) => onChange(c ? undefined : null)} />
          Link to a Case
        </Label>
      )}
      {on && <CasePicker enabled value={value ? String(value) : null} onChange={(v) => onChange(Number(v))} />}
    </div>
  );
}

/** Where a Workflow Run stands, as a dot and a word. */
export function RunStateBadge({ state }: { state: WorkflowRunState }) {
  const tone =
    state === "failed" ? "bg-destructive" : state === "pending" || state === "running" ? "bg-reconnecting" : state === "completed" ? "bg-live" : "bg-muted-foreground/40";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
      <span aria-hidden className={cn("size-1.5 rounded-full", tone, state === "running" && "motion-safe:animate-pulse")} />
      {workflowRunStateLabel[state]}
    </span>
  );
}

/**
 * The Workflows section of the Actions tab (ADR 0017): every on-demand Falcon Fusion SOAR workflow
 * discovered through the Organization's CrowdStrike Integrations, each runnable from here, and how
 * discovery is doing.
 */
export function WorkflowsSection() {
  const list = useQuery(workflowsQuery);
  const queryClient = useQueryClient();
  const [running, setRunning] = useState<Workflow | null>(null);
  const refresh = useMutation({
    mutationFn: refreshWorkflows,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: actionCenterKey }),
    onError: (e) => toast.error(e.message),
  });
  const sources = list.data?.sources ?? [];
  const refreshing = refresh.isPending || sources.some((s) => s.refreshing);
  // Workflows Falcon no longer lists stay recorded for their runs, but aren't offered.
  const shown = list.data?.workflows.filter((w) => w.status !== "removed") ?? [];

  return (
    <section aria-labelledby="group-workflow" className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="group-workflow" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Workflows <span className="font-normal tracking-normal normal-case">· Runs a Falcon Fusion SOAR workflow on demand and follows it to its outcome</span>
        </h2>
        {sources.length > 0 && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {sources.length === 1 && sources[0]!.checkedAt && (
              <span>
                Discovered <Time iso={sources[0]!.checkedAt} />
              </span>
            )}
            <Button size="sm" variant="ghost" className="h-7" disabled={refreshing} onClick={() => refresh.mutate()}>
              <RefreshCwIcon className={cn(refreshing && "motion-safe:animate-spin")} />
              {refreshing ? "Discovering…" : "Refresh"}
            </Button>
          </span>
        )}
      </div>
      {list.isPending && <Skeleton className="h-24" />}
      {list.isError && (
        <Alert variant="destructive">
          <AlertDescription>{list.error.message}</AlertDescription>
        </Alert>
      )}
      {sources
        .filter((s) => s.error)
        .map((s) => (
          <Alert key={s.integration.id}>
            <AlertDescription>
              {s.integration.name}: {s.error}
            </AlertDescription>
          </Alert>
        ))}
      {list.data && sources.length === 0 && (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">Workflows are discovered through a CrowdStrike Integration. Your Organization has none.</p>
      )}
      {list.data && sources.length > 0 && shown.length === 0 && !refreshing && (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">No Falcon Fusion SOAR workflows were found. Build one with an On demand trigger in Falcon, then Refresh.</p>
      )}
      {shown.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
          {shown.map((w) => (
            <li key={w.id} className={cn("grid content-start gap-1.5 rounded-lg border p-3", w.status !== "ready" && "opacity-70")}>
              <div className="min-w-0">
                <p className="font-medium">{w.name}</p>
                <p className="truncate text-xs text-muted-foreground">CrowdStrike · {w.integration.name}</p>
              </div>
              {w.description && <p className="line-clamp-2 text-xs text-muted-foreground">{w.description}</p>}
              {w.inputs.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {w.inputs.map((i) => (
                    <Badge key={i.name} variant="outline" className="font-normal text-muted-foreground">
                      {i.label}
                      {i.required && <span aria-label="required">*</span>}
                    </Badge>
                  ))}
                </div>
              )}
              <div className="mt-0.5 flex items-center justify-between gap-2">
                <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground" title={w.statusText}>
                  <span aria-hidden className={cn("size-1.5 flex-none rounded-full", w.status === "ready" ? "bg-live" : "bg-muted-foreground/40")} />
                  <span className="truncate">{w.statusText}</span>
                </span>
                {w.status === "ready" && (
                  <Button size="sm" variant="outline" className="flex-none" onClick={() => setRunning(w)} aria-label={`Run ${w.name} through ${w.integration.name}`}>
                    Run…
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {running && <RunWorkflowDialog workflow={running} onClose={() => setRunning(null)} />}
    </section>
  );
}

type Values = Record<string, string | boolean>;

/** The form's values for a run asked for again with `inputs`, or blank. */
const initialValues = (workflow: Pick<Workflow, "inputs">, inputs?: Record<string, unknown>): Values =>
  Object.fromEntries(
    workflow.inputs.map((i) => {
      const v = inputs?.[i.name];
      return [i.name, i.type === "boolean" ? v === true : v === undefined || v === null ? "" : String(v)];
    }),
  );

/**
 * Runs one Workflow: a field per input its trigger declares (or free JSON when it declares none), an
 * optional Case, and a reason without one. Once queued, it follows the run to its outcome.
 */
export function RunWorkflowDialog({
  workflow,
  initialInputs,
  initialCase = null,
  onClose,
}: {
  workflow: Pick<Workflow, "id" | "name" | "description" | "inputs" | "integration">;
  initialInputs?: Record<string, unknown>;
  initialCase?: number | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Values>(() => initialValues(workflow, initialInputs));
  const [json, setJson] = useState(() => (initialInputs && Object.keys(initialInputs).length ? JSON.stringify(initialInputs, null, 2) : ""));
  // null: no Case; undefined: a Case, not picked yet.
  const [caseNumber, setCaseNumber] = useState<number | null | undefined>(initialCase);
  const [reason, setReason] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const declared = workflow.inputs.length > 0;

  let parsed: Record<string, string | number | boolean | null> | null = {};
  let jsonError: string | null = null;
  if (!declared && json.trim()) {
    try {
      const v: unknown = JSON.parse(json);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
      parsed = v as Record<string, string | number | boolean | null>;
    } catch {
      parsed = null;
      jsonError = "Give the inputs as a JSON object, such as {\"hostname\": \"FIN-LT-0231\"}";
    }
  }
  const missing = workflow.inputs.filter((i) => i.required && i.type !== "boolean" && !String(values[i.name] ?? "").trim());
  const needsReason = caseNumber === null && !reason.trim();
  const needsCase = caseNumber === undefined;

  const run = useMutation({
    mutationFn: () =>
      runWorkflow(workflow.id, {
        inputs: declared ? values : (parsed ?? {}),
        caseNumber: caseNumber ?? null,
        reason: caseNumber === null ? reason.trim() : null,
      }),
    onSuccess: (id) => {
      void queryClient.invalidateQueries({ queryKey: actionCenterKey });
      setRunId(id);
    },
  });

  if (runId) return <WorkflowRunDialog id={runId} onClose={onClose} />;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{workflow.name}</DialogTitle>
          <DialogDescription>
            Falcon Fusion SOAR · CrowdStrike · {workflow.integration.name}
            {workflow.description && <span className="block">{workflow.description}</span>}
          </DialogDescription>
        </DialogHeader>
        <form
          id="workflow-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate();
          }}
        >
          {declared ? (
            <fieldset className="grid gap-3">
              <legend className="sr-only">Inputs</legend>
              {workflow.inputs.map((i) => {
                const id = `workflow-input-${i.name}`;
                if (i.type === "boolean") {
                  return (
                    <Label key={i.name} className="flex items-start gap-2 font-normal">
                      <Checkbox className="mt-0.5" checked={values[i.name] === true} onCheckedChange={(c) => setValues((v) => ({ ...v, [i.name]: !!c }))} />
                      <span>
                        {i.label}
                        {i.description && <span className="block text-xs text-muted-foreground">{i.description}</span>}
                      </span>
                    </Label>
                  );
                }
                return (
                  <div key={i.name} className="grid gap-1.5">
                    <Label htmlFor={id}>
                      {i.label}
                      {!i.required && <span className="font-normal text-muted-foreground"> · optional</span>}
                    </Label>
                    {i.options ? (
                      <NativeSelect id={id} className="w-full" value={String(values[i.name] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}>
                        <option value="">{i.required ? "Choose…" : "None"}</option>
                        {i.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <Input
                        id={id}
                        type={i.type === "string" ? "text" : "number"}
                        step={i.type === "integer" ? 1 : "any"}
                        value={String(values[i.name] ?? "")}
                        onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}
                        className="font-mono text-xs"
                        spellCheck={false}
                        autoComplete="off"
                      />
                    )}
                    {i.description && <p className="text-xs text-muted-foreground">{i.description}</p>}
                  </div>
                );
              })}
            </fieldset>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="workflow-json">
                Inputs <span className="font-normal text-muted-foreground">· optional; its trigger declares none Argus can read</span>
              </Label>
              <Textarea id="workflow-json" value={json} onChange={(e) => setJson(e.target.value)} className="min-h-20 font-mono text-xs" spellCheck={false} placeholder="{}" />
              {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
            </div>
          )}
          <CaseChoice value={caseNumber} onChange={setCaseNumber} />
          {caseNumber === null && (
            <div className="grid gap-1.5">
              <Label htmlFor="workflow-reason">Reason · recorded with the run in place of a Case</Label>
              <Input id="workflow-reason" value={reason} maxLength={REASON_MAX_LENGTH} onChange={(e) => setReason(e.target.value)} placeholder="Why this is being run" />
            </div>
          )}
          {run.error && (
            <Alert variant="destructive">
              <AlertDescription>{run.error.message}</AlertDescription>
            </Alert>
          )}
        </form>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">Can't be undone from Argus · recorded in the Action Log and an Audit Log</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="workflow-form"
              disabled={missing.length > 0 || !!jsonError || needsReason || needsCase || run.isPending}
              title={missing.length ? `Fill in ${missing.map((m) => m.label).join(", ")}` : needsReason ? "Give a reason, or link to a Case" : needsCase ? "Pick a Case" : undefined}
            >
              {run.isPending ? "Running…" : "Run Workflow"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What a run returned, as JSON. */
const outputText = (output: unknown) => (typeof output === "string" ? output : JSON.stringify(output, null, 2));

/** One run's details as Falcon last reported them, followed live until it ends. */
export function WorkflowRunDetails({ run }: { run: WorkflowRun }) {
  const inputs = Object.entries(run.inputs);
  return (
    <div className="grid gap-3 text-sm">
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border bg-muted/50 px-3 py-2">
        <dt className="text-muted-foreground">State</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <RunStateBadge state={run.state} />
          {run.falconStatus && <span className="text-xs text-muted-foreground">Falcon: {run.falconStatus}</span>}
        </dd>
        <dt className="text-muted-foreground">Case</dt>
        <dd>{run.case ? <CaseRef number={run.case.number} title={run.case.title} /> : <span className="text-muted-foreground">None · “{run.reason}”</span>}</dd>
        <dt className="text-muted-foreground">Run by</dt>
        <dd>
          {run.by.name}, <Time iso={run.createdAt} />
        </dd>
        {run.finishedAt && (
          <>
            <dt className="text-muted-foreground">Ended</dt>
            <dd>
              <Time iso={run.finishedAt} />
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Inputs</dt>
        <dd className="font-mono text-xs break-all">{inputs.length ? inputs.map(([k, v]) => `${k}=${String(v)}`).join(" · ") : "None"}</dd>
        {run.executionId && (
          <>
            <dt className="text-muted-foreground">Execution</dt>
            <dd className="font-mono text-xs break-all">{run.executionId}</dd>
          </>
        )}
      </dl>
      {run.error && (
        <Alert variant={run.state === "running" ? "default" : "destructive"}>
          <AlertDescription>{run.state === "running" ? `Last check failed, trying again: ${run.error}` : run.error}</AlertDescription>
        </Alert>
      )}
      {run.state === "pending" && <p className="text-muted-foreground">Queued; the worker sends it to Falcon in a few seconds.</p>}
      {run.activities.length > 0 && (
        <div className="grid gap-1">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Steps</h3>
          <ol className="grid gap-1 rounded-md border p-2" aria-label="Steps">
            {run.activities.map((a, n) => (
              <li key={`${n}:${a.name}`} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{a.name}</span>
                <span className="flex-none text-xs text-muted-foreground">{a.status}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {run.output !== null && (
        <div className="grid gap-1">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Output</h3>
          <pre className="max-h-48 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap break-all">{outputText(run.output)}</pre>
        </div>
      )}
    </div>
  );
}

/** A Workflow Run, followed live: Retry for one Falcon couldn't be asked for, and Run again once it has ended. */
export function WorkflowRunDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const run = useQuery(workflowRunQuery(id));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [again, setAgain] = useState(false);
  const retry = useMutation({
    mutationFn: () => retryWorkflowRun(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: actionCenterKey }),
  });
  const r = run.data;
  if (again && r) {
    return (
      <RunWorkflowDialog
        workflow={{ id: r.workflow.id, name: r.workflow.name, description: null, inputs: r.workflow.inputs, integration: r.integration }}
        initialInputs={r.inputs}
        initialCase={r.case?.number ?? null}
        onClose={onClose}
      />
    );
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{r?.workflow.name ?? "Workflow run"}</DialogTitle>
          <DialogDescription>
            Falcon Fusion SOAR · CrowdStrike · {r?.integration.name}
            {r?.case && ` · for ${caseRef(r.case.number)}`}
          </DialogDescription>
        </DialogHeader>
        {run.isPending && <Skeleton className="h-40" />}
        {run.isError && (
          <Alert variant="destructive">
            <AlertDescription>{run.error.message}</AlertDescription>
          </Alert>
        )}
        {r && <WorkflowRunDetails run={r} />}
        {retry.error && (
          <Alert variant="destructive">
            <AlertDescription>{retry.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="items-center sm:justify-between">
          <Button variant="link" className="h-auto p-0 text-xs" onClick={() => void navigate({ to: "/actions/log" })}>
            View in Action Log
          </Button>
          <div className="flex gap-2">
            {r?.retryable && (
              <Button variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>
                Retry
              </Button>
            )}
            {r && isFinished(r.state) && !r.retryable && (
              <Button variant="outline" onClick={() => setAgain(true)}>
                Run again…
              </Button>
            )}
            <Button onClick={onClose}>{r && !isFinished(r.state) ? "Close · keeps running" : "Done"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
