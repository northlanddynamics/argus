import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { DatePicker } from "@/components/date-picker";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";
import { caseKey } from "@/lib/cases";
import { mentionableQuery } from "@/lib/discussion";
import { type TaskView, tasksKey } from "@/lib/tasks";

type Fields = { title: string; description: string; ownerId: string; dueDate: string };

const fieldsOf = (task: TaskView): Fields => ({
  title: task.title,
  description: task.description,
  ownerId: task.owner.id,
  dueDate: task.dueDate ?? "",
});

/**
 * New Task, or editing one. An edit sends the version it started from; if someone saved a newer
 * one meanwhile, the save is refused and the dialog shows theirs.
 */
export function TaskDialog({
  number,
  task,
  defaultOwnerId,
  onClose,
}: {
  number: number;
  /** The Task to edit, or null for a new one. */
  task: TaskView | null;
  defaultOwnerId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<Fields>(
    task ? fieldsOf(task) : { title: "", description: "", ownerId: defaultOwnerId, dueDate: "" },
  );
  /** The Task as it was when editing started (or last reloaded). */
  const [base, setBase] = useState<TaskView | null>(task);
  const [conflict, setConflict] = useState<TaskView | null>(null);
  /** A new Task hidden from Guests; an existing one's marking changes from the Tasks table. */
  const [internal, setInternal] = useState(false);
  /** Who can own it: the people who can see the Case, Guests included unless it's Internal. */
  const people = useQuery(mentionableQuery(number));
  const hidden = base ? base.internal : internal;
  const owners = (people.data ?? []).filter((p) => !hidden || p.role !== "guest");

  const save = useMutation({
    mutationFn: async (f: Fields) => {
      const param = { number: String(number) };
      const dueDate = f.dueDate || null;
      if (!base) {
        const res = await api.cases[":number"].tasks.$post({ param, json: { ...f, dueDate, internal } });
        if (!res.ok) throw new Error(await errorMessage(res, "Could not create the Task"));
        return { kind: "saved" } as const;
      }
      // Only what changed, so a field nobody touched isn't recorded as an edit.
      const was = fieldsOf(base);
      const res = await api.cases[":number"].tasks[":id"].$patch({
        param: { ...param, id: base.id },
        json: {
          version: base.version,
          ...(f.title !== was.title && { title: f.title }),
          ...(f.description !== was.description && { description: f.description }),
          ...(f.ownerId !== was.ownerId && { ownerId: f.ownerId }),
          ...(f.dueDate !== was.dueDate && { dueDate }),
        },
      });
      if (res.status === 409) {
        const body = await res.json();
        // A newer version carries `current`; a Closed Case refuses with only an error.
        if ("current" in body) return { kind: "conflict", current: body.current as TaskView } as const;
        throw new Error(body.error);
      }
      if (!res.ok) throw new Error(await errorMessage(res, "Could not save the Task"));
      return { kind: "saved" } as const;
    },
    onSuccess: (result) => {
      if (result.kind === "conflict") {
        setConflict(result.current);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: tasksKey(number) });
      void queryClient.invalidateQueries({ queryKey: caseKey(number), exact: true });
      onClose();
    },
  });

  const loadCurrent = () => {
    if (!conflict) return;
    setBase(conflict);
    setFields(fieldsOf(conflict));
    setConflict(null);
    void queryClient.invalidateQueries({ queryKey: tasksKey(number) });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate(fields);
  };

  const set = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }));
  const ownerKnown = owners.some((p) => p.id === fields.ownerId);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{base ? "Edit Task" : "New Task"}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          {conflict && (
            <Alert className="border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80">
              <AlertTitle>Not saved — the Task changed since you opened it</AlertTitle>
              <AlertDescription className="grid gap-2">
                <p>
                  Now: <span className="font-medium">{conflict.title}</span>, owned by {conflict.owner.name}, due{" "}
                  {conflict.dueDate ?? "—"} (v{conflict.version}).
                </p>
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={loadCurrent}>
                    Load current
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          <FieldGroup>
          <Field>
            <FieldLabel htmlFor="task-title">Title</FieldLabel>
            <Input id="task-title" value={fields.title} onChange={(e) => set({ title: e.target.value })} required maxLength={300} />
          </Field>
          <Field>
            <FieldLabel htmlFor="task-description">Description</FieldLabel>
            <Textarea id="task-description" value={fields.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="task-owner">Owner</FieldLabel>
              <Select
                required
                value={!base && !ownerKnown ? "" : fields.ownerId}
                onValueChange={(ownerId) => set({ ownerId })}
              >
                <SelectTrigger id="task-owner" className="w-full">
                  <SelectValue placeholder="Choose an owner" />
                </SelectTrigger>
                <SelectContent>
                  {/* Someone who can no longer see the Case stays selectable until someone changes it. */}
                  {base && !ownerKnown && fields.ownerId === base.owner.id && <SelectItem value={base.owner.id}>{base.owner.name}</SelectItem>}
                  {owners.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.role === "guest" ? `${p.name} (Guest)` : p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="task-due">Due date (optional)</FieldLabel>
              <DatePicker id="task-due" value={fields.dueDate} onChange={(dueDate) => set({ dueDate })} placeholder="No due date" />
            </Field>
          </div>
          {!base && (
            <Field orientation="horizontal">
              <Checkbox
                id="task-internal"
                checked={internal}
                onCheckedChange={(checked) => {
                  setInternal(checked === true);
                  // A Guest can't own an Internal Task: hand it back to whoever is creating it.
                  if (checked === true && people.data?.find((p) => p.id === fields.ownerId)?.role === "guest") set({ ownerId: defaultOwnerId });
                }}
              />
              <FieldContent>
                <FieldLabel htmlFor="task-internal">Internal</FieldLabel>
                <FieldDescription>Hidden from Guests; a Guest can't own it.</FieldDescription>
              </FieldContent>
            </Field>
          )}
          </FieldGroup>
          {save.error && (
            <Alert variant="destructive">
              <AlertDescription>{save.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !!conflict}>
              {base ? "Save" : "Create Task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
