import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import type { Matcher } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** A calendar day as `YYYY-MM-DD`, the shape `<input type="date">` used. */
export type DayString = string;

const pad = (n: number) => String(n).padStart(2, "0");

/** The day `value` names, as midnight where the viewer is; none for "". */
export const parseDay = (value: DayString): Date | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
};

export const formatDay = (date: Date): DayString => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * A date field: a button showing the chosen day that opens a calendar. Holds `YYYY-MM-DD` (or ""
 * for none), so it stands in for `<input type="date">`.
 */
export function DatePicker({
  id,
  value,
  onChange,
  placeholder = "Pick a date",
  disabled,
  clearable = true,
  className,
  size = "default",
  "aria-invalid": invalid,
}: {
  id?: string;
  value: DayString;
  onChange: (value: DayString) => void;
  /** Shown when no day is chosen. */
  placeholder?: string;
  /** Days that can't be picked. */
  disabled?: Matcher | Matcher[];
  /** Offers a way back to no day. */
  clearable?: boolean;
  className?: string;
  /** `sm` for a filter bar. */
  size?: "default" | "sm";
  "aria-invalid"?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseDay(value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="picker"
          size={size}
          data-empty={!selected}
          aria-invalid={invalid}
          className={cn("w-full justify-between", className)}
        >
          {/* `YYYY-MM-DD`: one unambiguous form, beside UTC times and due dates. */}
          {selected ? value : placeholder}
          <CalendarIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          disabled={disabled}
          onSelect={(day) => {
            onChange(day ? formatDay(day) : "");
            setOpen(false);
          }}
        />
        {clearable && selected && (
          <div className="border-t p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
