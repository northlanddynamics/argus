import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { DatePicker } from "@/components/date-picker";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
/** What the form holds: `YYYY-MM-DDTHH:mm` values in UTC. */
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
  internal,
  onSubmit,
  onCancel,
}: {
  number: number;
  /** Keeps field ids unique when more than one form is on the page. */
  idPrefix: string;
  /** For a new entry: whether it's Internal, and a way to change that. */
  internal?: { value: boolean; onChange: (internal: boolean) => void };
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
  const incomplete = fields.at === "" || (fields.kind === "range" && fields.end === "");
  const citable = tasks.data?.filter((t) => !fields.citations.some((c) => c.id === t.id)) ?? [];
  const rangeBackwards = fields.kind === "range" && fields.at !== "" && fields.end !== "" && fields.end <= fields.at;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (rangeBackwards || incomplete) return;
    onSubmit({ occurredAt: occurredAtOf(fields), body: fields.body.trim(), citations: fields.citations }, () => setFields(blankFields()));
  };

  return (
    <form className="grid gap-4" onSubmit={submit} aria-label={submitLabel}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium" id={id("kind")}>
          Occurred at
        </span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-labelledby={id("kind")}
          value={fields.kind}
          // Choosing the current kind again would clear it; there is always one.
          onValueChange={(kind) => kind && set({ kind: kind as Kind })}
        >
          {(["exact", "range", "approximate"] as const).map((kind) => (
            <ToggleGroupItem key={kind} value={kind}>
              {occurredKindLabel[kind]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <UtcDateTimeField
          id={id("at")}
          label={fields.kind === "range" ? "From (UTC)" : fields.kind === "approximate" ? "Around (UTC)" : "At (UTC)"}
          value={fields.at}
          onChange={(at) => set({ at })}
        />
        {fields.kind === "range" && (
          <UtcDateTimeField id={id("end")} label="To (UTC)" value={fields.end} invalid={rangeBackwards} onChange={(end) => set({ end })} />
        )}
        {fields.kind === "approximate" && (
          <Field>
            <FieldLabel htmlFor={id("precision")}>Give or take</FieldLabel>
            <Select value={String(fields.precisionMinutes)} onValueChange={(value) => set({ precisionMinutes: Number(value) })}>
              <SelectTrigger id={id("precision")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* An entry saved with another precision keeps it until changed. */}
                {!PRECISIONS.includes(fields.precisionMinutes as (typeof PRECISIONS)[number]) && (
                  <SelectItem value={String(fields.precisionMinutes)}>{precisionLabel(fields.precisionMinutes)}</SelectItem>
                )}
                {PRECISIONS.map((p) => (
                  <SelectItem key={p} value={String(p)}>
                    {precisionLabel(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>
      {rangeBackwards && <p className="text-sm text-destructive">A range must end after it starts.</p>}
      <Field>
        <FieldLabel htmlFor={id("body")}>What happened</FieldLabel>
        <Textarea id={id("body")} required maxLength={10_000} value={fields.body} onChange={(e) => set({ body: e.target.value })} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Cites</span>
        {fields.citations.map((c) => (
          <Badge key={`${c.kind}:${c.id}`} variant="secondary" className="gap-1">
            Task · {taskTitle(c.id)}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="-mr-1 size-4 rounded-full"
              aria-label={`Remove citation Task · ${taskTitle(c.id)}`}
              onClick={() => set({ citations: fields.citations.filter((x) => x !== c) })}
            >
              <XIcon />
            </Button>
          </Badge>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={!citable.length}>
              + Cite a Task
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {citable.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => set({ citations: [...fields.citations, { kind: "task", id: t.id }] })}>
                {t.title}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-end gap-2">
        {internal && (
          <Field orientation="horizontal" className="mr-auto w-auto">
            <Checkbox id={id("internal")} checked={internal.value} onCheckedChange={(checked) => internal.onChange(checked === true)} />
            <FieldContent>
              <FieldLabel htmlFor={id("internal")}>Internal</FieldLabel>
              <FieldDescription className="text-xs">Hidden from Guests</FieldDescription>
            </FieldContent>
          </Field>
        )}
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending || disabled || rangeBackwards || incomplete || !fields.body.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** A UTC instant to the minute, as `YYYY-MM-DDTHH:mm`: a day from a calendar and a time typed in. */
function UtcDateTimeField({
  id,
  label,
  value,
  invalid,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  /** The time typed before any day is picked. */
  const [pendingTime, setPendingTime] = useState("00:00");
  const day = value.slice(0, 10);
  const time = value ? value.slice(11, 16) : pendingTime;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <DatePicker id={id} value={day} clearable={false} className="w-auto min-w-0 flex-1 shrink" aria-invalid={invalid} onChange={(next) => onChange(next ? `${next}T${time}` : "")} />
        <Input
          type="time"
          aria-label={`${label} time`}
          className="w-28 shrink-0 appearance-none bg-background [&::-webkit-calendar-picker-indicator]:hidden"
          required
          value={time}
          aria-invalid={invalid}
          onChange={(e) => {
            const next = e.target.value || "00:00";
            if (value) onChange(`${day}T${next}`);
            else setPendingTime(next);
          }}
        />
      </div>
    </Field>
  );
}

/** Adds an entry to the Timeline; with `source`, Promotes that Discussion message or Audit Log entry. */
export function NewEntryForm({
  number,
  initial = blankFields(),
  source,
  defaultInternal = false,
  submitLabel = "Add entry",
  onDone,
  onCancel,
}: {
  number: number;
  initial?: EntryFields;
  source?: PromotionSource;
  /** Whether it starts out Internal: as the message it Promotes is. */
  defaultInternal?: boolean;
  submitLabel?: string;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const [internal, setInternal] = useState(defaultInternal);
  const add = useMutation({
    mutationFn: async (json: { occurredAt: OccurredAt; body: string; citations: Citation[] }) => {
      const res = await api.cases[":number"].timeline.$post({ param: { number: String(number) }, json: { ...json, source, internal } });
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
      internal={{ value: internal, onChange: setInternal }}
      onSubmit={(input, reset) =>
        add.mutate(input, {
          onSuccess: () => {
            reset();
            setInternal(defaultInternal);
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
        <Alert className="border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80">
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
  internal = false,
  onClose,
}: {
  number: number;
  source: PromotionSource;
  /** When the source happened (ISO), as the entry's starting point. */
  occurredAt: string;
  body: string;
  /** The source is Internal, so the entry starts out Internal too. */
  internal?: boolean;
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
          defaultInternal={internal}
          initial={{ ...blankFields(), at: toUtcInput(occurredAt), body }}
          submitLabel="Promote"
          onDone={onClose}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
