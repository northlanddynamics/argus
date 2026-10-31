import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { caseKey, caseRef, casesKey, RESOLUTIONS, type Resolution, resolutionLabel } from "@/lib/cases";
import { cn } from "@/lib/utils";

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
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Resolution (required)</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {RESOLUTIONS.map((r) => (
                <label
                  key={r}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm",
                    resolution === r && "border-primary ring-1 ring-primary",
                  )}
                >
                  <input type="radio" name="resolution" value={r} checked={resolution === r} onChange={() => setResolution(r)} />
                  {resolutionLabel[r]}
                </label>
              ))}
            </div>
          </fieldset>
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
