import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
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
            <Alert className="border-amber-300 bg-amber-50 text-amber-950">
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
          <div className="grid gap-2">
            <Label htmlFor="task-title">Title</Label>
            <Input id="task-title" value={fields.title} onChange={(e) => set({ title: e.target.value })} required maxLength={300} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-description">Description</Label>
            <Textarea id="task-description" value={fields.description} onChange={(e) => set({ description: e.target.value })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="task-owner">Owner</Label>
              <NativeSelect id="task-owner" value={fields.ownerId} onChange={(e) => set({ ownerId: e.target.value })} required>
                {/* Someone who can no longer see the Case stays selectable until someone changes it. */}
                {base && !ownerKnown && fields.ownerId === base.owner.id && (
                  <NativeSelectOption value={base.owner.id}>{base.owner.name}</NativeSelectOption>
                )}
                {!base && !ownerKnown && <NativeSelectOption value="">Choose an owner</NativeSelectOption>}
                {owners.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.role === "guest" ? `${p.name} (Guest)` : p.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="task-due">Due date (optional)</Label>
              <Input id="task-due" type="date" value={fields.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
            </div>
          </div>
          {!base && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="task-internal"
                checked={internal}
                onCheckedChange={(checked) => {
                  setInternal(checked === true);
                  // A Guest can't own an Internal Task: hand it back to whoever is creating it.
                  if (checked === true && people.data?.find((p) => p.id === fields.ownerId)?.role === "guest") set({ ownerId: defaultOwnerId });
                }}
              />
              <Label htmlFor="task-internal">Internal</Label>
              <span className="text-sm text-muted-foreground">Hidden from Guests; a Guest can't own it.</span>
            </div>
          )}
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
