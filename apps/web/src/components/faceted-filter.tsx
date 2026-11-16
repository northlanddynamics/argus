import { CheckIcon, PlusCircleIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** Past this many values a facet gets a search box. */
const SEARCHABLE = 8;
/** Past this many picked values the button names how many rather than each. */
const NAMED = 2;

/**
 * One facet of a list: a button that opens its values, each with how many items in the list have it,
 * to pick any number of. Picking none is no filter. A value no item has stays pickable, muted.
 */
export function FacetedFilter<T extends string>({
  title,
  options,
  labels,
  counts,
  selected = [],
  onChange,
}: {
  title: string;
  options: readonly T[];
  labels: Record<T, string>;
  /** Items with each value; undefined while they load. */
  counts?: Partial<Record<T, number>>;
  selected?: readonly T[];
  /** An empty pick is undefined, so the filter leaves the URL. */
  onChange: (selected: T[] | undefined) => void;
}) {
  const picked = new Set(selected);
  const toggle = (value: T) => {
    const next = options.filter((o) => (o === value ? !picked.has(o) : picked.has(o)));
    onChange(next.length ? next : undefined);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <PlusCircleIcon aria-hidden />
          {title}
          {picked.size > 0 && (
            <>
              <Separator orientation="vertical" className="mx-0.5 data-[orientation=vertical]:h-4" />
              {picked.size > NAMED ? (
                <Badge variant="secondary">
                  {picked.size} selected
                </Badge>
              ) : (
                options
                  .filter((o) => picked.has(o))
                  .map((o) => (
                    <Badge key={o} variant="secondary">
                      {labels[o]}
                    </Badge>
                  ))
              )}
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" align="start">
        <Command>
          {options.length > SEARCHABLE && <CommandInput placeholder={title} />}
          <CommandList>
            <CommandEmpty>No matches</CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const on = picked.has(o);
                const n = counts?.[o] ?? 0;
                return (
                  <CommandItem key={o} value={labels[o]} onSelect={() => toggle(o)} className="[&>svg]:hidden">
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-4 items-center justify-center rounded-xs border border-input",
                        on && "border-primary bg-primary text-primary-foreground",
                      )}
                    >
                      {on && <CheckIcon className="size-3.5 text-current!" />}
                    </span>
                    <span className="sr-only">{on ? "Selected: " : ""}</span>
                    <span className={cn("truncate", !on && counts && n === 0 && "text-muted-foreground")}>{labels[o]}</span>
                    {counts && <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">{n}</span>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {picked.size > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem onSelect={() => onChange(undefined)} className="justify-center text-center">
                    Clear {title}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
