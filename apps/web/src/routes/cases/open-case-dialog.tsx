import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { RichTextEditor } from "@/components/rich-text-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { api, errorMessage } from "@/lib/api";
import {
  CASE_TYPES,
  type CaseSummary,
  type CaseType,
  caseTypeLabel,
  casesKey,
  emptySummary,
  SEVERITIES,
  type Severity,
  severityLabel,
} from "@/lib/cases";

/** "+ Open Case": title, Case Type, Severity and Case Summary; the new Case starts in New. */
export function OpenCaseDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [summary, setSummary] = useState<CaseSummary>(emptySummary);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const open = useMutation({
    mutationFn: async (json: { title: string; caseType: CaseType; severity: Severity; summary: CaseSummary }) => {
      const res = await api.cases.$post({ json });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not open the Case"));
      return (await res.json()).case;
    },
    onSuccess: async (opened) => {
      await queryClient.invalidateQueries({ queryKey: casesKey });
      setIsOpen(false);
      await navigate({ to: "/cases/$number", params: { number: String(opened.number) } });
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    open.mutate({
      title: String(form.get("title")),
      caseType: form.get("caseType") as CaseType,
      severity: form.get("severity") as Severity,
      summary,
    });
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        setIsOpen(next);
        if (next) {
          setSummary(emptySummary());
          open.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>+ Open Case</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Open a Case</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="case-title">Title</Label>
            <Input id="case-title" name="title" required maxLength={300} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="case-type">Case Type</Label>
              <NativeSelect id="case-type" name="caseType" defaultValue="phishing">
                {CASE_TYPES.map((t) => (
                  <NativeSelectOption key={t} value={t}>
                    {caseTypeLabel[t]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="case-severity">Severity</Label>
              <NativeSelect id="case-severity" name="severity" defaultValue="medium">
                {SEVERITIES.map((s) => (
                  <NativeSelectOption key={s} value={s}>
                    {severityLabel[s]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Case Summary</Label>
            <RichTextEditor label="Case Summary" value={summary} onChange={setSummary} className="rounded-md border p-3" />
          </div>
          {open.error && (
            <Alert variant="destructive">
              <AlertDescription>{open.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="submit" disabled={open.isPending}>
              Open Case
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
