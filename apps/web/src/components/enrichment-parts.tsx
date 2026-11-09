import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { bulkLookup } from "@/lib/bulk-lookup";
import { type EnrichableType, useEnrichmentPanel } from "@/lib/enrichment";
import { cn } from "@/lib/utils";

/**
 * What the Enrichment panel's content shares, whatever it shows: the frame each type's content is
 * laid out in (`ip-details.tsx`, `hash-details.tsx`, `domain-details.tsx`, `url-details.tsx`), the
 * value's header, where Argus already holds it, a section per source, and values in a report that
 * open their own Enrichment. Laid out in `docs/wireframes/enrichment-panel.md`.
 */

/** Set inside the panel: its top bar (Back, the type, ↑ ↓, ✕), drawn above each type's header. */
const PanelFrame = createContext<{ nav: ReactNode } | null>(null);

export const PanelFrameProvider = PanelFrame.Provider;

/** The header (pinned while the sections scroll), then a section per source. */
export function EnrichmentLayout({ header, children }: { header: ReactNode; children: ReactNode }) {
  const frame = useContext(PanelFrame);
  return (
    <>
      <div className="sticky top-0 z-10 grid gap-1 border-b bg-background px-4 pt-2 pb-3">
        {frame?.nav}
        {header}
      </div>
      {children}
    </>
  );
}

/**
 * The value whole and wrapped, Copy, and ↗ to it on its source's site when there is a page to open.
 * `copy` is what Copy copies, `children` anything shown under it.
 */
export function ValueHeader({
  shown,
  copy,
  copied,
  href,
  hrefLabel,
  children,
}: {
  shown: string;
  copy: string;
  copied: string;
  href: string | null;
  hrefLabel: string;
  children?: ReactNode;
}) {
  const onCopy = () =>
    void navigator.clipboard.writeText(copy).then(
      () => toast(copied),
      () => toast.error("Couldn't copy to the clipboard"),
    );
  return (
    <div className="grid gap-0.5">
      <div className="flex items-start gap-1">
        <span className="min-w-0 flex-1 py-0.5 font-mono text-sm font-medium break-all">{shown}</span>
        <Button variant="ghost" size="icon-xs" onClick={onCopy} aria-label="Copy" title="Copy">
          <CopyIcon aria-hidden />
        </Button>
        {href && (
          <Button variant="ghost" size="icon-xs" asChild>
            <a href={href} target="_blank" rel="noreferrer noopener" aria-label={hrefLabel} title={hrefLabel}>
              <ExternalLinkIcon aria-hidden />
            </a>
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "In 3 Cases · Open its page →", when Argus holds the value as an Observable that appears somewhere. */
export function KnownLine({ type, value }: { type: EnrichableType; value: string }) {
  const q = useQuery({ queryKey: ["enrichment-known", type, value], queryFn: () => bulkLookup(value), staleTime: 30_000 });
  const known = q.data?.find((r) => r.type === type)?.known;
  if (!known) return null;
  const where = known.cases.length ? plural(known.cases.length, "Case") : plural(known.alerts.length, "Alert");
  return (
    <p className="text-xs">
      In {where} ·{" "}
      <Link to="/observables/$id" params={{ id: known.id }} className="underline underline-offset-2 hover:text-muted-foreground">
        Open its page →
      </Link>
    </p>
  );
}

/** One source's report, headed by its name, with its own "as of" footer. */
export function SourceSection({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-3 border-b p-4 text-sm">
      <h3 className="text-base font-medium">{title}</h3>
      {children}
      {footer}
    </section>
  );
}

/**
 * A value in a report (an IP a domain resolves to, the URL a URL ends at) that opens its own
 * Enrichment: in the panel, replacing what it shows and adding Back; elsewhere, such as on an
 * Observable's page, by opening the panel. Guests get the value as text.
 */
export function FollowValue({ type, value, className, children }: { type: EnrichableType; value: string; className?: string; children: ReactNode }) {
  const panel = useEnrichmentPanel();
  const inPanel = useContext(PanelFrame) !== null;
  const text = cn("font-mono text-xs break-all", className);
  if (!panel.available) return <span className={text}>{children}</span>;
  return (
    <button
      type="button"
      className={cn(text, "cursor-pointer text-left underline underline-offset-2 outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50")}
      onClick={(e) => (inPanel ? panel.follow({ type, value }) : panel.open({ type, value }, { from: e.currentTarget }))}
    >
      {children}
    </button>
  );
}
