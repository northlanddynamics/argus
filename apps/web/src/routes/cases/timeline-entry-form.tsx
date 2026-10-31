import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";
import { tasksQuery } from "@/lib/tasks";
import {
  type Citation,
  describeOccurredAt,
  fromUtcInput,
  type OccurredAt,
  occurredKindLabel,
  PRECISIONS,
  precisionLabel,
  type PromotionSource,
  type TimelineEntryView,
  timelineKey,
  toUtcInput,
} from "@/lib/timeline";

type Kind = OccurredAt["kind"];
/** What the form holds: `datetime-local` values in UTC. */
export type EntryFields = {
  kind: Kind;
  at: string;
  end: string;
  precisionMinutes: number;
  body: string;
  citations: Citation[];
};

export const blankFields = (): EntryFields => ({
  kind: "exact",
  at: "",
  end: "",
  precisionMinutes: 360,
  body: "",
  citations: [],
});

/** The form's fields for an entry, or for a new one that happened at `at` (ISO). */
export function fieldsOf(entry: Pick<TimelineEntryView, "occurredAt" | "body" | "citations">): EntryFields {
  const o = entry.occurredAt;
  const citations = entry.citations.map(({ kind, id }) => ({ kind, id }));
  switch (o.kind) {
    case "exact":
      return { ...blankFields(), at: toUtcInput(o.at), body: entry.body, citations };
    case "range":
      return { ...blankFields(), kind: "range", at: toUtcInput(o.start), end: toUtcInput(o.end), body: entry.body, citations };
    case "approximate":
      return { ...blankFields(), kind: "approximate", at: toUtcInput(o.at), precisionMinutes: o.precisionMinutes, body: entry.body, citations };
  }
}

const occurredAtOf = (f: EntryFields): OccurredAt => {
  switch (f.kind) {
    case "exact":
      return { kind: "exact", at: fromUtcInput(f.at) };
    case "range":
      return { kind: "range", start: fromUtcInput(f.at), end: fromUtcInput(f.end) };
    case "approximate":
      return { kind: "approximate", at: fromUtcInput(f.at), precisionMinutes: f.precisionMinutes };
  }
};

/**
 * A Timeline Entry's occurred-at, text and citations. Occurred-at is exact, a range or approximate
 * (an instant give or take a precision); times are entered in UTC. Recorded-at is set by Argus.
 */
function EntryForm({
  number,
  idPrefix,
  initial,
  submitLabel,
  pending,
  error,
  disabled,
  onSubmit,
  onCancel,
}: {
  number: number;
  /** Keeps field ids unique when more than one form is on the page. */
  idPrefix: string;
  initial: EntryFields;
  submitLabel: string;
  pending: boolean;
  error?: string;
  disabled?: boolean;
  onSubmit: (input: { occurredAt: OccurredAt; body: string; citations: Citation[] }, reset: () => void) => void;
  onCancel?: () => void;
}) {
  const [fields, setFields] = useState(initial);
  const tasks = useQuery(tasksQuery(number));
  const set = (patch: Partial<EntryFields>) => setFields((f) => ({ ...f, ...patch }));
  const id = (name: string) => `${idPrefix}-${name}`;
  const taskTitle = (taskId: string) => tasks.data?.find((t) => t.id === taskId)?.title ?? "(not found)";
  const rangeBackwards = fields.kind === "range" && fields.at !== "" && fields.end !== "" && fields.end <= fields.at;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (rangeBackwards) return;
    onSubmit({ occurredAt: occurredAtOf(fields), body: fields.body.trim(), citations: fields.citations }, () => setFields(blankFields()));
  };

  return (
    <form className="grid gap-4" onSubmit={submit} aria-label={submitLabel}>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Occurred at">
        <span className="text-sm font-medium">Occurred at</span>
        {(["exact", "range", "approximate"] as const).map((kind) => (
          <Button
            key={kind}
            type="button"
            size="sm"
            variant={fields.kind === kind ? "default" : "outline"}
            aria-pressed={fields.kind === kind}
            onClick={() => set({ kind })}
          >
            {occurredKindLabel[kind]}
          </Button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={id("at")}>{fields.kind === "range" ? "From (UTC)" : fields.kind === "approximate" ? "Around (UTC)" : "At (UTC)"}</Label>
          <Input id={id("at")} type="datetime-local" required value={fields.at} onChange={(e) => set({ at: e.target.value })} />
        </div>
        {fields.kind === "range" && (
          <div className="grid gap-2">
            <Label htmlFor={id("end")}>To (UTC)</Label>
            <Input
              id={id("end")}
              type="datetime-local"
              required
              value={fields.end}
              aria-invalid={rangeBackwards}
              onChange={(e) => set({ end: e.target.value })}
            />
          </div>
        )}
        {fields.kind === "approximate" && (
          <div className="grid gap-2">
            <Label htmlFor={id("precision")}>Give or take</Label>
            <NativeSelect
              id={id("precision")}
              value={String(fields.precisionMinutes)}
              onChange={(e) => set({ precisionMinutes: Number(e.target.value) })}
            >
              {/* An entry saved with another precision keeps it until changed. */}
              {!PRECISIONS.includes(fields.precisionMinutes as (typeof PRECISIONS)[number]) && (
                <NativeSelectOption value={String(fields.precisionMinutes)}>{precisionLabel(fields.precisionMinutes)}</NativeSelectOption>
              )}
              {PRECISIONS.map((p) => (
                <NativeSelectOption key={p} value={String(p)}>
                  {precisionLabel(p)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>
      {rangeBackwards && <p className="text-sm text-destructive">A range must end after it starts.</p>}
      <div className="grid gap-2">
        <Label htmlFor={id("body")}>What happened</Label>
        <Textarea id={id("body")} required maxLength={10_000} value={fields.body} onChange={(e) => set({ body: e.target.value })} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Cites</span>
        {fields.citations.map((c) => (
          <Badge key={`${c.kind}:${c.id}`} variant="secondary" className="gap-1">
            Task · {taskTitle(c.id)}
            <button
              type="button"
              className="ml-1 text-muted-foreground hover:text-foreground"
              aria-label={`Remove citation Task · ${taskTitle(c.id)}`}
              onClick={() => set({ citations: fields.citations.filter((x) => x !== c) })}
            >
              ×
            </button>
          </Badge>
        ))}
        <NativeSelect
          aria-label="Cite a Task"
          value=""
          onChange={(e) => {
            const taskId = e.target.value;
            if (taskId && !fields.citations.some((c) => c.id === taskId)) set({ citations: [...fields.citations, { kind: "task", id: taskId }] });
          }}
        >
          <NativeSelectOption value="">+ Cite a Task</NativeSelectOption>
          {tasks.data
            ?.filter((t) => !fields.citations.some((c) => c.id === t.id))
            .map((t) => (
              <NativeSelectOption key={t.id} value={t.id}>
                {t.title}
              </NativeSelectOption>
            ))}
        </NativeSelect>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending || disabled || rangeBackwards || !fields.body.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Adds an entry to the Timeline; with `source`, Promotes that Discussion message or Audit Log entry. */
export function NewEntryForm({
  number,
  initial = blankFields(),
  source,
  submitLabel = "Add entry",
  onDone,
  onCancel,
}: {
  number: number;
  initial?: EntryFields;
  source?: PromotionSource;
  submitLabel?: string;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: async (json: { occurredAt: OccurredAt; body: string; citations: Citation[] }) => {
      const res = await api.cases[":number"].timeline.$post({ param: { number: String(number) }, json: { ...json, source } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not add the entry"));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: timelineKey(number) }),
  });
  return (
    <EntryForm
      number={number}
      idPrefix={source ? "promote" : "new-entry"}
      initial={initial}
      submitLabel={submitLabel}
      pending={add.isPending}
      error={add.error?.message}
      onSubmit={(input, reset) =>
        add.mutate(input, {
          onSuccess: () => {
            reset();
            onDone?.();
          },
        })
      }
      onCancel={onCancel}
    />
  );
}

/**
 * Edits an entry. The save carries the version editing started from; if someone saved a newer one
 * meanwhile, it is refused and the form offers theirs.
 */
export function EditEntryForm({ number, entry, onDone }: { number: number; entry: TimelineEntryView; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [base, setBase] = useState(entry);
  const [conflict, setConflict] = useState<TimelineEntryView | null>(null);
  const save = useMutation({
    mutationFn: async (json: { occurredAt: OccurredAt; body: string; citations: Citation[] }) => {
      const res = await api.cases[":number"].timeline[":id"].$patch({
        param: { number: String(number), id: base.id },
        json: { ...json, version: base.version },
      });
      if (res.status === 409) {
        const body = await res.json();
        // A newer version carries `current`; a Closed Case or a retracted entry refuses with only an error.
        if ("current" in body) return { kind: "conflict", current: body.current as TimelineEntryView } as const;
        throw new Error(body.error);
      }
      if (!res.ok) throw new Error(await errorMessage(res, "Could not save the entry"));
      return { kind: "saved" } as const;
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: timelineKey(number) });
      if (result.kind === "conflict") setConflict(result.current);
      else onDone();
    },
  });
  return (
    <div className="grid gap-4">
      {conflict && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-950">
          <AlertTitle>Not saved — the entry changed since you opened it</AlertTitle>
          <AlertDescription className="grid gap-2">
            <p>
              Now: {describeOccurredAt(conflict.occurredAt)} · {conflict.body} (v{conflict.version})
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setBase(conflict);
                  setConflict(null);
                }}
              >
                Load current
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <EntryForm
        // Remounts with the loaded version's fields.
        key={base.version}
        number={number}
        idPrefix={`edit-${entry.id}`}
        initial={fieldsOf(base)}
        submitLabel="Save"
        pending={save.isPending}
        disabled={!!conflict}
        error={save.error?.message}
        onSubmit={(input) => save.mutate(input)}
        onCancel={onDone}
      />
    </div>
  );
}

/** Promotes a Discussion message or Audit Log entry: a new entry, prefilled from it, that links back. */
export function PromoteDialog({
  number,
  source,
  occurredAt,
  body,
  onClose,
}: {
  number: number;
  source: PromotionSource;
  /** When the source happened (ISO), as the entry's starting point. */
  occurredAt: string;
  body: string;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Promote to Timeline</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The new Timeline Entry links back to this {source.kind === "discussion_message" ? "Discussion message" : "Audit Log entry"}. Set
          when it happened in the real world.
        </p>
        <NewEntryForm
          number={number}
          source={source}
          initial={{ ...blankFields(), at: toUtcInput(occurredAt), body }}
          submitLabel="Promote"
          onDone={onClose}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
