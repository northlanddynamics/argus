import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { RichTextEditor } from "@/components/rich-text-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
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
import { cn } from "@/lib/utils";

/** What a bulk action did, for the queue's notice: `verb` is "attached to C-12", "dismissed"… */
export type BulkOutcome = BulkResult & { verb: string };

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The open Cases the Member can see, newest first, matching `filter` by number or title. */
function useOpenCases(enabled: boolean, filter: string) {
  const cases = useQuery({
    queryKey: [...casesKey, "attach-candidates"],
    queryFn: async () => {
      const res = await api.cases.$get({ query: { view: "open" } });
      if (!res.ok) throw new Error("Could not load Cases");
      return (await res.json()).cases.toSorted((a, b) => b.number - a.number);
    },
    enabled,
  });
  const needle = filter.trim().toLowerCase().replace(/^c-/, "");
  const matching = cases.data?.filter((c) => !needle || String(c.number).startsWith(needle) || c.title.toLowerCase().includes(needle));
  return { ...cases, matching };
}

/** A list of Cases to choose one from, as radio cards. */
function CasePicker({
  enabled,
  value,
  onChange,
  exclude,
}: {
  enabled: boolean;
  value: number | null;
  onChange: (number: number) => void;
  exclude?: number;
}) {
  const [filter, setFilter] = useState("");
  const cases = useOpenCases(enabled, filter);
  const shown = cases.matching?.filter((c) => c.number !== exclude).slice(0, 20);
  return (
    <div className="grid gap-2">
      <Label htmlFor="case-filter">Find a Case</Label>
      <Input id="case-filter" placeholder="C-1041 or words in the title" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="grid max-h-64 gap-2 overflow-y-auto" role="radiogroup" aria-label="Case">
        {shown?.map((c) => (
          <label
            key={c.number}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm",
              value === c.number && "border-primary ring-1 ring-primary",
            )}
          >
            <input type="radio" name="case" className="mt-1" checked={value === c.number} onChange={() => onChange(c.number)} />
            <span className="grid">
              <span>
                <span className="font-semibold">{caseRef(c.number)}</span> {c.title}
              </span>
              <span className="text-xs text-muted-foreground">
                {statusLabel[c.status]} · {severityLabel[c.severity]}
                {c.assignee && ` · ${c.assignee.name}`}
              </span>
            </span>
          </label>
        ))}
        {shown?.length === 0 && <p className="text-sm text-muted-foreground">No open Case matches.</p>}
      </div>
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

function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}

/** Posts a bulk action and reads its result; anything but a result is an error. */
async function bulk(res: Response, fallback: string): Promise<BulkResult> {
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  return (await res.json()) as BulkResult;
}

/** "Open Case from N Alerts": a new Case with the selected Alerts attached; Severity defaults to the highest of theirs. */
export function OpenCaseFromAlertsDialog({
  open,
  onOpenChange,
  selection,
  highest,
  onDone,
}: DialogProps & { selection: AlertSelection; highest: Severity; onDone: (outcome: BulkOutcome) => void }) {
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
      if (!res.ok) throw new Error(await errorMessage(res, "Could not open the Case"));
      return (await res.json()) as BulkResult & { case: { number: number } };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: alertsKey });
      await queryClient.invalidateQueries({ queryKey: casesKey });
      onOpenChange(false);
      onDone({ ...result, verb: result.case ? `attached to ${caseRef(result.case.number)}` : "attached; no Case was opened" });
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Open Case from {plural(selection.length, "Alert")}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="from-alerts-title">Title</Label>
            <Input id="from-alerts-title" name="title" required maxLength={300} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="from-alerts-type">Case Type</Label>
              <NativeSelect id="from-alerts-type" name="caseType" defaultValue="malware">
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
          <Note>The Alerts become Attached to the new Case, recorded in its Audit Log.</Note>
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
  selection,
  onDone,
}: DialogProps & { selection: AlertSelection; onDone: (outcome: BulkOutcome) => void }) {
  const [target, setTarget] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const attach = useMutation({
    mutationFn: async (number: number) =>
      bulk(await api.alerts.attach.$post({ json: { case: number, alerts: selection } }), "Could not attach the Alerts"),
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
      <DialogContent>
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
          <CasePicker enabled={open} value={target} onChange={setTarget} />
          <Note>Alerts already attached elsewhere are moved; both Cases’ Audit Logs record it.</Note>
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
        "Could not dismiss the Alerts",
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
      <DialogContent>
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
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Dismissal Reason (required)</legend>
            {DISMISSAL_REASONS.map((r) => (
              <label
                key={r}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm",
                  reason === r && "border-primary ring-1 ring-primary",
                )}
              >
                <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
                {dismissalReasonLabel[r]}
              </label>
            ))}
          </fieldset>
          <div className="grid gap-2">
            <Label htmlFor="dismiss-comment">Comment (optional)</Label>
            <Textarea id="dismiss-comment" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          <Note>Each dismissal is recorded in the Organization Audit Log. Alerts on a Case are left as they are: detach them first.</Note>
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
      if (!res.ok) throw new Error(await errorMessage(res, "Could not move the Alert"));
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
            <p className="text-sm">
              Currently on{" "}
              <span className="rounded-full border px-2 py-0.5 text-xs">
                {caseRef(current.number)} {current.title}
              </span>
            </p>
          )}
          {!detachOnly && <CasePicker enabled={open} value={typeof target === "number" ? target : null} onChange={setTarget} exclude={current?.number} />}
          <label
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm",
              target === "detach" && "border-primary ring-1 ring-primary",
            )}
          >
            <input type="radio" name="case" checked={target === "detach"} onChange={() => setTarget("detach")} />
            <span>
              <span className="font-semibold">Detach</span> — return to the queue as New
            </span>
          </label>
          <Note>Both Cases’ Audit Logs record a move; a detachment is recorded in this Case’s.</Note>
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
