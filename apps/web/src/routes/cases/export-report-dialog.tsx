import { DownloadIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { api } from "@/lib/api";
import { caseRef } from "@/lib/cases";
import {
  REPORT_FORMATS,
  REPORT_VARIANTS,
  type ReportFormat,
  type ReportVariant,
  reportFormatLabel,
  reportVariantLabel,
} from "api/case-reports/vocabulary";

const VARIANT_DESCRIPTIONS: Record<ReportVariant, string> = {
  complete: "Everything on the Case, Internal items included and marked.",
  guest_safe: "Leaves out every Internal item, safe to share outside the team.",
};

const reportUrl = (number: number, variant: ReportVariant, format: ReportFormat) =>
  api.cases[":number"].report.$url({ param: { number: String(number) }, query: { variant, format } }).toString();

/**
 * "Export": a Case Report as PDF or Markdown, complete or Guest-safe. `complete` is whether the
 * viewer may export the complete one (Guests may not). Every export is recorded in the Audit Log.
 */
export function ExportReportDialog({ number, complete }: { number: number; complete: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const variants = complete ? REPORT_VARIANTS : (["guest_safe"] as const);
  const [variant, setVariant] = useState<ReportVariant>(variants[0]);
  const [format, setFormat] = useState<ReportFormat>("pdf");

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        setIsOpen(next);
        if (next) setVariant(variants[0]);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <DownloadIcon aria-hidden /> Export
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export Case Report for {caseRef(number)}</DialogTitle>
          <DialogDescription>
            The Case Summary, Timeline, Tasks, Observables, Assets and Evidence with SHA-256 fingerprints, as they are now. The export is
            recorded in the Audit Log.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FieldSet>
            <FieldLegend variant="label">Variant</FieldLegend>
            <RadioGroup name="variant" value={variant} onValueChange={(value) => setVariant(value as ReportVariant)}>
              {variants.map((v) => (
                <FieldLabel key={v} htmlFor={`report-variant-${v}`}>
                  <Field orientation="horizontal">
                    <RadioGroupItem value={v} id={`report-variant-${v}`} />
                    <div className="grid gap-1">
                      <FieldTitle>{reportVariantLabel[v]}</FieldTitle>
                      <FieldDescription>{VARIANT_DESCRIPTIONS[v]}</FieldDescription>
                    </div>
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">Format</FieldLegend>
            <RadioGroup name="format" value={format} onValueChange={(value) => setFormat(value as ReportFormat)} className="grid-cols-2">
              {REPORT_FORMATS.map((f) => (
                <FieldLabel key={f} htmlFor={`report-format-${f}`}>
                  <Field orientation="horizontal">
                    <RadioGroupItem value={f} id={`report-format-${f}`} />
                    <FieldTitle>{reportFormatLabel[f]}</FieldTitle>
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          </FieldSet>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button asChild>
              <a href={reportUrl(number, variant, format)} download onClick={() => setIsOpen(false)}>
                <DownloadIcon aria-hidden /> Export {reportFormatLabel[format]}
              </a>
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
