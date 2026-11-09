import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { SearchIcon } from "lucide-react";
import { RichTextEditor } from "@/components/rich-text-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useDebounced } from "@/hooks/use-debounced";
import {
  type AlertDetail,
  type AlertSelection,
  alertsKey,
  type BulkResult,
  DISMISSAL_REASONS,
  type DismissalReason,
  dismissalReasonLabel,
  type Refusal,
} from "@/lib/alerts";
import { api, errorMessage } from "@/lib/api";
import {
  CASE_TYPES,
  type CaseSummary,
  type CaseType,
  caseRef,
  casesKey,
  caseTypeLabel,
  emptySummary,
  SEVERITIES,
  type Severity,
  severityLabel,
  statusLabel,
} from "@/lib/cases";

/** What a bulk action did, for the queue's notice: `verb` is "attached to C-12", "dismissed"…; `note` adds what else follows from it. */
export type BulkOutcome = BulkResult & { verb: string; note?: string };

/** `onCloseAutoFocus`: where focus goes once the dialog has closed; call `preventDefault` to send it elsewhere than the opener. */
type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus?: (event: Event) => void };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How many Cases the picker offers at once. */
const PICKER_TOP = 3;

/** The open Cases the Member can see, most recently opened first, matching `filter` by number or title. */
function useOpenCases(enabled: boolean, filter: string) {
  const cases = useQuery({
    queryKey: [...casesKey, "attach-candidates"],
    queryFn: async () => {
      const res = await api.cases.$get({ query: { view: "open" } });
      if (!res.ok) throw new Error("Couldn't load Cases");
      return (await res.json()).cases.toSorted((a, b) => b.openedAt.localeCompare(a.openedAt) || b.number - a.number);
    },
    enabled,
  });
  const needle = filter.trim().toLowerCase().replace(/^c-/, "");
  const matching = cases.data?.filter((c) => !needle || String(c.number).startsWith(needle) || c.title.toLowerCase().includes(needle));
  return { ...cases, matching };
}

/**
 * Cases to choose one from, as radio cards: the three most recently opened, or the top three matches
 * for what's typed in the search box. `children` adds choices of its own to the same group.
 */
export function CasePicker({
  enabled,
  value,
  onChange,
  exclude,
  children,
}: {
  enabled: boolean;
  value: string | null;
  onChange: (value: string) => void;
  exclude?: number;
  children?: ReactNode;
}) {
  const [filter, setFilter] = useState("");
  const settled = useDebounced(filter, 200);
  const cases = useOpenCases(enabled, settled);
  const shown = cases.matching?.filter((c) => c.number !== exclude).slice(0, PICKER_TOP);
  return (
    <div className="grid gap-2">
      <Label htmlFor="case-filter">Search Cases</Label>
      <div className="relative">
        <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="case-filter"
          type="search"
          className="pl-8"
          placeholder="C-1041 or words in the title"
          autoComplete="off"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">{settled.trim() ? "Top matches" : "Most recently opened"}</p>
      <RadioGroup aria-label="Case" value={value ?? ""} onValueChange={onChange} className="p-0.5">
        {shown?.map((c) => (
          <FieldLabel key={c.number} htmlFor={`case-${c.number}`}>
            <Field orientation="horizontal">
              <RadioGroupItem value={String(c.number)} id={`case-${c.number}`} />
              <FieldContent>
                <FieldTitle>
                  <span className="font-mono text-xs text-muted-foreground">{caseRef(c.number)}</span> {c.title}
                </FieldTitle>
                <FieldDescription className="text-xs">
                  {statusLabel[c.status]} · {severityLabel[c.severity]}
                  {c.assignee && ` · ${c.assignee.name}`}
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldLabel>
        ))}
        {cases.isPending && enabled && <p className="text-sm text-muted-foreground">Loading open Cases…</p>}
        {cases.isError && <p className="text-sm text-destructive">Couldn't load Cases. Close this and try again.</p>}
        {shown?.length === 0 && <p className="text-sm text-muted-foreground">No open Case matches.</p>}
        {children}
      </RadioGroup>
    </div>
  );
}

function Failure({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

/**
 * Why a request failed, in words a Member can act on: the server's own explanation when it gives one
 * (a Case was Closed, not found…), or `fallback` and a suggestion to try again when it had a problem.
 */
async function failure(res: Response, fallback: string) {
  if (res.status >= 500) return `${fallback}: Argus had a problem on its side. Try again in a moment.`;
  return errorMessage(res, fallback);
}

function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-md border px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}

/** Posts a bulk action and reads its result; anything but a result is an error. */
async function bulk(res: Response, fallback: string): Promise<BulkResult> {
  if (!res.ok) throw new Error(await failure(res, fallback));
  return (await res.json()) as BulkResult;
}

/**
 * "Open Case from N Alerts": a new Case with the selected Alerts attached. Severity defaults to the
 * highest of theirs; the title and Case Type start from the most serious Alert.
 */
export function OpenCaseFromAlertsDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  selection,
  highest,
  suggested,
  onDone,
}: DialogProps & {
  selection: AlertSelection;
  highest: Severity;
  suggested: { title: string; caseType: CaseType };
  onDone: (outcome: BulkOutcome) => void;
}) {
  const [summary, setSummary] = useState<CaseSummary>(emptySummary);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const create = useMutation({
    mutationFn: async (json: { title: string; caseType: CaseType; severity: Severity; summary: CaseSummary }) => {
      const res = await api.alerts.cases.$post({ json: { ...json, alerts: selection } });
      if (res.status === 409) {
        const body = (await res.json()) as { refused?: Refusal[] };
        return { case: null, applied: [], refused: body.refused ?? [] };
      }
      if (!res.ok) throw new Error(await failure(res, "Couldn't open the Case"));
      return (await res.json()) as BulkResult & { case: { number: number } };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: alertsKey });
      await queryClient.invalidateQueries({ queryKey: casesKey });
      onOpenChange(false);
      onDone(
        result.case
          ? { ...result, verb: `attached to ${caseRef(result.case.number)}` }
          : { ...result, verb: "attached", note: "No Case was opened, because none of the Alerts could be attached." },
      );
      if (result.case && !result.refused.length) await navigate({ to: "/cases/$number", params: { number: String(result.case.number) } });
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      title: String(form.get("title")),
      caseType: form.get("caseType") as CaseType,
      severity: form.get("severity") as Severity,
      summary,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) {
          setSummary(emptySummary());
          create.reset();
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Open Case from {plural(selection.length, "Alert")}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="from-alerts-title">Title</Label>
            <Input id="from-alerts-title" name="title" required maxLength={300} defaultValue={suggested.title} key={suggested.title} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="from-alerts-type">Case Type</Label>
              <NativeSelect id="from-alerts-type" name="caseType" defaultValue={suggested.caseType} key={suggested.caseType}>
                {CASE_TYPES.map((t) => (
                  <NativeSelectOption key={t} value={t}>
                    {caseTypeLabel[t]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="from-alerts-severity">Severity</Label>
              <NativeSelect id="from-alerts-severity" name="severity" defaultValue={highest} key={highest}>
                {SEVERITIES.map((s) => (
                  <NativeSelectOption key={s} value={s}>
                    {severityLabel[s]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Severity defaults to the highest selected Alert ({severityLabel[highest]}); you can change it.
          </p>
          <div className="grid gap-2">
            <Label>Case Summary</Label>
            <RichTextEditor label="Case Summary" value={summary} onChange={setSummary} className="rounded-md border p-3" />
          </div>
          <Failure error={create.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Open Case
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Attach N Alerts to a Case": an open Case the Member can see. Alerts on another Case move. */
export function AttachAlertsDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  selection,
  onDone,
}: DialogProps & { selection: AlertSelection; onDone: (outcome: BulkOutcome) => void }) {
  const [target, setTarget] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const attach = useMutation({
    mutationFn: async (number: number) =>
      bulk(await api.alerts.attach.$post({ json: { case: number, alerts: selection } }), "Couldn't attach the Alerts"),
    onSuccess: async (result, number) => {
      await queryClient.invalidateQueries({ queryKey: alertsKey });
      onOpenChange(false);
      onDone({ ...result, verb: `attached to ${caseRef(number)}` });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) {
          setTarget(null);
          attach.reset();
        }
      }}
    >
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Attach {plural(selection.length, "Alert")} to a Case</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (target) attach.mutate(target);
          }}
        >
          <CasePicker enabled={open} value={target === null ? null : String(target)} onChange={(v) => setTarget(Number(v))} />
          <Note>Alerts already attached elsewhere are moved.</Note>
          <Failure error={attach.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!target || attach.isPending}>
              Attach
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Dismiss N Alerts": a Dismissal Reason is required. */
export function DismissAlertsDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  selection,
  onDone,
}: DialogProps & { selection: AlertSelection; onDone: (outcome: BulkOutcome) => void }) {
  const [reason, setReason] = useState<DismissalReason | null>(null);
  const [comment, setComment] = useState("");
  const queryClient = useQueryClient();

  const dismiss = useMutation({
    mutationFn: async (chosen: DismissalReason) =>
      bulk(
        await api.alerts.dismiss.$post({ json: { reason: chosen, comment: comment.trim() || undefined, alerts: selection } }),
        "Couldn't dismiss the Alerts",
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: alertsKey });
      onOpenChange(false);
      onDone({ ...result, verb: "dismissed" });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) {
          setReason(null);
          setComment("");
          dismiss.reset();
        }
      }}
    >
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Dismiss {plural(selection.length, "Alert")}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason) dismiss.mutate(reason);
          }}
        >
          <FieldSet>
            <FieldLegend variant="label">Dismissal Reason (required)</FieldLegend>
            <RadioGroup value={reason ?? ""} onValueChange={(v) => setReason(v as DismissalReason)} className="sm:grid-cols-2">
              {DISMISSAL_REASONS.map((r) => (
                <FieldLabel key={r} htmlFor={`dismissal-${r}`}>
                  <Field orientation="horizontal">
                    <RadioGroupItem value={r} id={`dismissal-${r}`} />
                    <FieldTitle>{dismissalReasonLabel[r]}</FieldTitle>
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          </FieldSet>
          <div className="grid gap-2">
            <Label htmlFor="dismiss-comment">Comment (optional)</Label>
            <Textarea id="dismiss-comment" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          <Failure error={dismiss.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!reason || dismiss.isPending}>
              Dismiss
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Move Alert": to another open Case, or detach it back to the queue as New. */
export function MoveAlertDialog({
  open,
  onOpenChange,
  alert,
  detachOnly = false,
}: DialogProps & { alert: AlertDetail; detachOnly?: boolean }) {
  const [target, setTarget] = useState<number | "detach" | null>(null);
  const queryClient = useQueryClient();
  const current = alert.attached?.case ?? null;

  const move = useMutation({
    mutationFn: async (to: number | "detach") => {
      const param = { id: alert.id };
      const res =
        to === "detach"
          ? await api.alerts[":id"].detach.$post({ param, json: { version: alert.version } })
          : await api.alerts[":id"].move.$post({ param, json: { case: to, version: alert.version } });
      if (!res.ok) throw new Error(await failure(res, to === "detach" ? "Couldn't detach the Alert" : "Couldn't move the Alert"));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: alertsKey });
      await queryClient.invalidateQueries({ queryKey: casesKey });
      onOpenChange(false);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) {
          setTarget(detachOnly ? "detach" : null);
          move.reset();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {detachOnly ? "Detach" : "Move"} Alert <span className="font-mono text-sm">{alert.externalId}</span>
          </DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (target !== null) move.mutate(target);
          }}
        >
          {current && (
            <p className="flex flex-wrap items-center gap-1.5 text-sm">
              Currently on
              <Badge variant="outline">
                <span className="font-mono">{caseRef(current.number)}</span> {current.title}
              </Badge>
            </p>
          )}
          {detachOnly ? (
            <p className="text-sm">It goes back to the Alert queue as New.</p>
          ) : (
            <CasePicker
              enabled={open}
              value={target === null ? null : String(target)}
              onChange={(v) => setTarget(v === "detach" ? "detach" : Number(v))}
              exclude={current?.number}
            >
              <FieldLabel htmlFor="move-detach">
                <Field orientation="horizontal">
                  <RadioGroupItem value="detach" id="move-detach" />
                  <FieldContent>
                    <FieldTitle>Detach</FieldTitle>
                    <FieldDescription className="text-xs">Back to the Alert queue as New, on no Case</FieldDescription>
                  </FieldContent>
                </Field>
              </FieldLabel>
            </CasePicker>
          )}
          <Failure error={move.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={target === null || move.isPending}>
              {target === "detach" ? "Detach" : "Move"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
