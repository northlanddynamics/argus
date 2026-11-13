import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * A record outside Argus that a value or Asset has: its page in VirusTotal, IPinfo.io, the Falcon
 * console. `source` names the site ("VirusTotal", "Falcon"); `detail` tells apart several records
 * on one site, such as the devices of an ambiguous host.
 */
export type SourceLink = { source: string; href: string; detail?: string };

const name = (l: SourceLink) => `Open in ${l.source}${l.detail ? ` (${l.detail})` : ""}`;

/**
 * A button per site that goes to the record there, in a new tab: "VirusTotal ↗". Several records
 * on one site (an ambiguous host's devices) share one button that opens a menu of them. Nothing when
 * there are no links. `size` "sm" is for a page header, "xs" (the default) for a card or the panel.
 */
export function SourceLinks({ links, size = "xs", className }: { links: SourceLink[]; size?: "xs" | "sm"; className?: string }) {
  if (links.length === 0) return null;
  const bySource = new Map<string, SourceLink[]>();
  for (const l of links) bySource.set(l.source, [...(bySource.get(l.source) ?? []), l]);
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {[...bySource].map(([source, records]) =>
        records.length === 1 ? (
          <Button key={source} variant="outline" size={size} asChild>
            <a href={records[0]!.href} target="_blank" rel="noreferrer noopener" aria-label={name(records[0]!)} title={name(records[0]!)}>
              {source}
              <ExternalLinkIcon aria-hidden data-icon="inline-end" />
            </a>
          </Button>
        ) : (
          <DropdownMenu key={source}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size={size} aria-label={`Open in ${source}: ${records.length} records`}>
                {source}
                <ChevronDownIcon aria-hidden data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-80">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Open in {source}</DropdownMenuLabel>
              {records.map((r) => (
                <DropdownMenuItem key={r.href} asChild>
                  <a href={r.href} target="_blank" rel="noreferrer noopener" className="font-mono text-xs break-all">
                    <ExternalLinkIcon aria-hidden />
                    {r.detail ?? r.href}
                  </a>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      )}
    </div>
  );
}
