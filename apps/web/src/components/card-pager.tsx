import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The pager a hover card shows when it has more than it can show at once, one page at a time: `‹`
 * and `›` either side of what is shown and where it is, as the account card steps through several
 * Falcon identities (`docs/wireframes/account-context-popup.md`). `‹` is disabled on the first page,
 * `›` on the last. `noun` names a page for the buttons' labels ("Previous identity"); `label`, when
 * given, names the page shown ("Location · 2 of 4" rather than "Identity 2 of 4").
 */
export function CardPager({
  at,
  count,
  onStep,
  noun,
  label,
}: {
  at: number;
  count: number;
  onStep: (index: number) => void;
  noun: string;
  label?: string;
}) {
  const title = `${noun[0]!.toUpperCase()}${noun.slice(1)}`;
  return (
    <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
      <Button variant="ghost" size="icon-xs" disabled={at === 0} onClick={() => onStep(at - 1)} aria-label={`Previous ${noun}`} title={`Previous ${noun}`}>
        <ChevronLeftIcon aria-hidden />
      </Button>
      <span className="tabular-nums" aria-live="polite">
        {label ? `${label} · ${at + 1} of ${count}` : `${title} ${at + 1} of ${count}`}
      </span>
      <Button variant="ghost" size="icon-xs" disabled={at === count - 1} onClick={() => onStep(at + 1)} aria-label={`Next ${noun}`} title={`Next ${noun}`}>
        <ChevronRightIcon aria-hidden />
      </Button>
    </div>
  );
}
