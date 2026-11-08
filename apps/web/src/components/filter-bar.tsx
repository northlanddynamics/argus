import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

/**
 * The row of filters above a list: each a small label beside a compact control, and Clear once any
 * is set. The Cases list, the Alert queue and both Audit Logs filter the same way.
 */
export function FilterBar({ children, onClear, label = "Clear" }: { children: ReactNode; /** Shown while a filter is set. */ onClear?: () => void; label?: string }) {
  return (
    <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
      {children}
      {onClear && (
        <Button variant="ghost" size="sm" onClick={onClear}>
          <XIcon aria-hidden />
          {label}
        </Button>
      )}
    </div>
  );
}

/** A DatePicker sized to sit in a FilterBar beside the small selects. */
export const DATE_FILTER = "h-7 w-36 rounded-[min(var(--radius-md),10px)] px-2.5";

/** One filter: its label, then its control. */
export function FilterField({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/**
 * A filter picking one of `options`. With `any`, the first choice is no filter at all (`undefined`),
 * labelled with it; without, every choice is one of `options`.
 */
export function FilterSelect<T extends string>({
  label,
  id,
  value,
  options,
  labels,
  any,
  onChange,
}: {
  label: string;
  id: string;
  value: T | undefined;
  options: readonly T[];
  labels: Record<T, string>;
  any?: string;
  onChange: (value: T | undefined) => void;
}) {
  return (
    <FilterField label={label} htmlFor={id}>
      <NativeSelect size="sm" id={id} value={value ?? ""} onChange={(e) => onChange((e.target.value || undefined) as T | undefined)}>
        {any !== undefined && <NativeSelectOption value="">{any}</NativeSelectOption>}
        {options.map((o) => (
          <NativeSelectOption key={o} value={o}>
            {labels[o]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </FilterField>
  );
}
