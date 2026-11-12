import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SEARCH_KINDS, type SearchKind, searchKindLabel } from "@/lib/search";

/**
 * Which kinds a search looks through, as toggles: none on means every kind. `counts`, when given,
 * follow each label ("Cases 5+" when there are more than shown).
 */
export function KindFilter({
  kinds,
  onChange,
  counts,
  className,
}: {
  kinds: SearchKind[];
  onChange: (kinds: SearchKind[]) => void;
  counts?: Partial<Record<SearchKind, string>>;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="multiple"
      variant="outline"
      size="sm"
      spacing={1}
      aria-label="Search in"
      className={className}
      value={kinds}
      onValueChange={(value) => onChange(SEARCH_KINDS.filter((k) => value.includes(k)))}
    >
      {SEARCH_KINDS.map((kind) => (
        <ToggleGroupItem key={kind} value={kind} variant="chip" size="sm">
          {searchKindLabel[kind]}
          {counts?.[kind] && <span className="ml-1 tabular-nums opacity-70">{counts[kind]}</span>}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
