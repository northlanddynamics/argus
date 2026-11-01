import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { api, errorMessage } from "@/lib/api";
import { caseKey, caseRef, casesKey, RESOLUTIONS, type Resolution, resolutionLabel } from "@/lib/cases";

/** "Close Case": a Resolution is required, and the Case becomes read-only. */
export function CloseCaseDialog({ number }: { number: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const queryClient = useQueryClient();

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
          <Alert className="border-amber-300 bg-amber-50 text-amber-950">
            <AlertDescription>The Case becomes read-only. Only an Admin can reopen it.</AlertDescription>
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
