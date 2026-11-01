import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type InternalItem, useMarkInternal } from "@/lib/internal";

/** The "Internal" marker: shown on items hidden from the Case's Guests. */
export function InternalBadge() {
  return (
    <Badge variant="outline" className="border-dashed border-foreground/50">
      Internal
    </Badge>
  );
}

/**
 * Whether an item is Internal or visible to the Case's Guests, for Members; with `canMark`, a
 * button to switch it. Shows nothing to Guests, who only ever see items that aren't Internal.
 */
export function Visibility({
  number,
  item,
  internal,
  label,
  canMark,
  showVisible = true,
}: {
  number: number;
  item: InternalItem;
  internal: boolean;
  /** What the item is called, for the button's accessible name. */
  label: string;
  canMark: boolean;
  /** Also say so when it's visible to Guests (in a table's Visibility column). */
  showVisible?: boolean;
}) {
  const mark = useMarkInternal(number);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {internal ? <InternalBadge /> : showVisible && <span className="text-xs text-muted-foreground">Visible to Guests</span>}
      {canMark && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          aria-label={internal ? `Show ${label} to Guests` : `Mark ${label} Internal`}
          title={internal ? "Show to Guests" : "Hide from Guests"}
          disabled={mark.isPending}
          onClick={() => mark.mutate({ item, internal: !internal })}
        >
          {internal ? <EyeIcon aria-hidden /> : <EyeOffIcon aria-hidden />}
          {internal ? "Show to Guests" : "Mark Internal"}
        </Button>
      )}
      {mark.error && (
        <span role="alert" className="text-xs text-destructive">
          {mark.error.message}
        </span>
      )}
    </span>
  );
}
