import { useQuery } from "@tanstack/react-query";
import { observableTypeLabel } from "api/observables/vocabulary";
import { ArrowLeftIcon, ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { DomainEnrichment } from "@/components/domain-details";
import { PanelFrameProvider } from "@/components/enrichment-parts";
import { HashEnrichment } from "@/components/hash-details";
import { IpEnrichment } from "@/components/ip-details";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { UrlEnrichment } from "@/components/url-details";
import { useIsMobile } from "@/hooks/use-mobile";
import { meQuery } from "@/lib/api";
import { type EnrichmentTarget, enrichmentKey, useEnrichmentPanel } from "@/lib/enrichment";
import { canManage } from "@/lib/roles";

/**
 * The Enrichment panel (`docs/wireframes/enrichment-panel.md`): what Argus's sources say about one
 * Observable, docked on the right of the content beside the page it was opened from, which narrows
 * to make room and dims (`EnrichmentScrim`). Below `md` it is a full-width sheet instead.
 */

const PANEL_HEADING = "enrichment-panel-heading";

/** The Observable's content, by type; each starts its lookup when it mounts. */
function Content({ target, admin }: { target: EnrichmentTarget; admin: boolean }) {
  switch (target.type) {
    case "ip":
      return <IpEnrichment ip={target.value} admin={admin} />;
    case "md5":
    case "sha1":
    case "sha256":
      return <HashEnrichment hash={target.value} type={target.type} />;
    case "domain":
    case "email":
      return <DomainEnrichment type={target.type} value={target.value} />;
    case "url":
      return <UrlEnrichment url={target.value} />;
  }
}

/** Back, the type, ↑ ↓ through the list it was opened from, and ✕. */
function Nav({ target, headingRef }: { target: EnrichmentTarget; headingRef: React.Ref<HTMLHeadingElement> }) {
  const panel = useEnrichmentPanel();
  const at = panel.position();
  return (
    <div className="-mr-2 flex items-center gap-0.5">
      {panel.history.length > 0 && (
        <Button variant="ghost" size="xs" className="-ml-2" onClick={panel.back}>
          <ArrowLeftIcon aria-hidden />
          Back
        </Button>
      )}
      <h2 id={PANEL_HEADING} ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 text-xs font-medium text-muted-foreground outline-none">
        {observableTypeLabel[target.type]}
        <span className="sr-only"> Enrichment</span>
      </h2>
      {at && (
        <>
          <Button variant="ghost" size="icon-sm" disabled={at.index === 0} onClick={() => panel.step(-1)} aria-label="Previous (K)" title="Previous (K)">
            <ChevronUpIcon aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" disabled={at.index === at.count - 1} onClick={() => panel.step(1)} aria-label="Next (J)" title="Next (J)">
            <ChevronDownIcon aria-hidden />
          </Button>
        </>
      )}
      <Button variant="ghost" size="icon-sm" onClick={panel.close} aria-label="Close" title="Close (Esc)">
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}

/** J and K step through the list, Esc closes, wherever focus is in the panel but a field. */
function onPanelKeyDown(e: KeyboardEvent, panel: ReturnType<typeof useEnrichmentPanel>) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const key = e.key.toLowerCase();
  if (key === "j" || key === "k") {
    e.preventDefault();
    panel.step(key === "j" ? 1 : -1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    panel.close();
  }
}

/**
 * Dims the page beside the docked panel while it is open, so the eye goes to the panel. Clicking
 * the dimmed page closes the panel; ↑ ↓ (J, K) still step through the list beneath it. On a phone
 * the sheet brings its own backdrop.
 */
export function EnrichmentScrim() {
  const panel = useEnrichmentPanel();
  const mobile = useIsMobile();
  if (!panel.current || mobile) return null;
  return <div data-slot="enrichment-scrim" aria-hidden className="absolute inset-0 z-1 bg-black/10 duration-100 animate-in fade-in-0" onClick={panel.close} />;
}

export function EnrichmentPanel() {
  const panel = useEnrichmentPanel();
  const mobile = useIsMobile();
  const role = useQuery(meQuery).data?.organization?.role;
  const heading = useRef<HTMLHeadingElement>(null);
  const target = panel.current;

  // Opened from the keyboard: focus moves to the panel, so its controls are next.
  useEffect(() => {
    if (panel.focusRequest) heading.current?.focus();
  }, [panel.focusRequest]);

  if (!target) return null;
  const body = (
    <PanelFrameProvider value={{ nav: <Nav target={target} headingRef={heading} /> }}>
      <Content key={enrichmentKey(target)} target={target} admin={!!role && canManage(role)} />
    </PanelFrameProvider>
  );

  if (mobile) {
    return (
      <Sheet open onOpenChange={(open) => !open && panel.close()}>
        <SheetContent side="right" showCloseButton={false} className="w-full gap-0 overflow-y-auto p-0 sm:max-w-none" onKeyDown={(e) => onPanelKeyDown(e, panel)}>
          <SheetTitle className="sr-only">{observableTypeLabel[target.type]} Enrichment</SheetTitle>
          <SheetDescription className="sr-only">What Argus's sources say about it</SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <aside
      aria-labelledby={PANEL_HEADING}
      className="sticky top-14 h-[calc(100svh-3.5rem)] w-[420px] shrink-0 self-start overflow-y-auto overscroll-contain border-l bg-background"
      onKeyDown={(e) => onPanelKeyDown(e, panel)}
    >
      {body}
    </aside>
  );
}
