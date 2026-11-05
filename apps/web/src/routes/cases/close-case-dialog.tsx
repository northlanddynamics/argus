import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { api, errorMessage } from "@/lib/api";
import { caseKey, caseRef, casesKey, RESOLUTIONS, type Resolution, resolutionLabel } from "@/lib/cases";
import { useGuests } from "@/lib/guests";
import { tasksQuery } from "@/lib/tasks";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Close Case": a Resolution is required, and the Case becomes read-only. */
export function CloseCaseDialog({ number }: { number: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const queryClient = useQueryClient();
  /** What closing leaves behind, read when the dialog opens. */
  const tasks = useQuery({ ...tasksQuery(number), enabled: isOpen });
  const guests = useGuests(number, isOpen);
  const open = (tasks.data ?? []).filter((t) => !t.done);
  const overdue = open.filter((t) => t.overdue).length;
  const activeGuests = (guests.data ?? []).filter((g) => !g.expired).length;

  const close = useMutation({
    mutationFn: async (chosen: Resolution) => {
      const res = await api.cases[":number"].close.$post({ param: { number: String(number) }, json: { resolution: chosen } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not close the Case"));
      const body = await res.json();
      if (!("case" in body)) throw new Error("Could not close the Case");
      return body.case;
    },
    onSuccess: (closed) => {
      queryClient.setQueryData(caseKey(number), closed);
      void queryClient.invalidateQueries({ queryKey: casesKey });
      setIsOpen(false);
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (resolution) close.mutate(resolution);
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        setIsOpen(next);
        if (next) {
          setResolution(null);
          close.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">Close Case</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close Case {caseRef(number)}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <FieldSet>
            <FieldLegend variant="label">Resolution (required)</FieldLegend>
            <RadioGroup
              name="resolution"
              required
              value={resolution ?? ""}
              onValueChange={(value) => setResolution(value as Resolution)}
              className="sm:grid-cols-2"
            >
              {RESOLUTIONS.map((r) => (
                <FieldLabel key={r} htmlFor={`resolution-${r}`}>
                  <Field orientation="horizontal">
                    <RadioGroupItem value={r} id={`resolution-${r}`} />
                    <FieldTitle>{resolutionLabel[r]}</FieldTitle>
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          </FieldSet>
          <Alert className="border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80">
            <AlertDescription>
              <ul className="grid list-disc gap-1 pl-4">
                {open.length > 0 && (
                  <li>
                    {plural(open.length, "Task")} {open.length === 1 ? "is" : "are"} not done
                    {overdue > 0 && ` (${overdue} overdue)`}: {open.slice(0, 3).map((t) => t.title).join("; ")}
                    {open.length > 3 && `; and ${open.length - 3} more`}. They stay as they are.
                  </li>
                )}
                {activeGuests > 0 && (
                  <li>
                    {plural(activeGuests, "Guest")} on this Case can still see it, read-only.
                  </li>
                )}
                <li>The Case becomes read-only for everyone.</li>
              </ul>
            </AlertDescription>
          </Alert>
          {close.error && (
            <Alert variant="destructive">
              <AlertDescription>{close.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!resolution || close.isPending}>
              Close Case
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
