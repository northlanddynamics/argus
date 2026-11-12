import { useQuery } from "@tanstack/react-query";
import { observableTypeLabel } from "api/observables/vocabulary";
import { ArrowLeftIcon, BellIcon, BellOffIcon, ChevronDownIcon, ChevronUpIcon, StarIcon, StarOffIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { DomainEnrichment } from "@/components/domain-details";
import { PanelFrameProvider } from "@/components/enrichment-parts";
import { HashEnrichment } from "@/components/hash-details";
import { IpEnrichment } from "@/components/ip-details";
import { useObservableIgnore } from "@/components/observable-ignore";
import { useObservableImportant } from "@/components/observable-important";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { UrlEnrichment } from "@/components/url-details";
import { meQuery } from "@/lib/api";
import { type EnrichmentTarget, enrichmentKey, useEnrichmentPanel } from "@/lib/enrichment";
import { canManage } from "@/lib/roles";

/**
 * The Enrichment panel (`docs/wireframes/enrichment-panel.md`): what Argus's sources say about one
 * Observable, in shadcn's Sheet on the right, 420px wide (full width on a phone), over the whole
 * page, which its overlay dims; clicking the page or Esc closes it.
 */

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

/** Back, the type (and "Important" or "Ignored" when it is), Mark Important for Members, Ignore for Admins, ↑ ↓ through the list it was opened from, and ✕. */
function Nav({ target, headingRef }: { target: EnrichmentTarget; headingRef: React.Ref<HTMLHeadingElement> }) {
  const panel = useEnrichmentPanel();
  const ignore = useObservableIgnore(target.type, target.value);
  const important = useObservableImportant(target.type, target.value);
  const at = panel.position();
  return (
    <div className="-mr-2 flex items-center gap-0.5">
      {panel.history.length > 0 && (
        <Button variant="ghost" size="xs" className="-ml-2" onClick={panel.back}>
          <ArrowLeftIcon aria-hidden />
          Back
        </Button>
      )}
      {/* The Sheet's title, so the dialog is named "IP Enrichment"; it shows only the type. */}
      <SheetTitle ref={headingRef} tabIndex={-1} className="min-w-0 flex-1">
        <span className="text-xs text-muted-foreground">{observableTypeLabel[target.type]}</span>
        <span className="sr-only"> Enrichment</span>
      </SheetTitle>
      {important.important && (
        <Badge variant="outline" className="mr-1">
          <StarIcon aria-hidden />
          Important
        </Badge>
      )}
      {important.available && (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={important.pending}
          onClick={important.toggle}
          aria-label={important.important ? "Unmark Important" : "Mark Important"}
          title={important.important ? "Unmark Important" : "Mark Important"}
        >
          {important.important ? <StarOffIcon aria-hidden /> : <StarIcon aria-hidden />}
        </Button>
      )}
      {ignore.ignored && (
        <Badge variant="outline" className="mr-1">
          <BellOffIcon aria-hidden />
          Ignored
        </Badge>
      )}
      {ignore.available && (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={ignore.pending}
          onClick={ignore.request}
          aria-label={ignore.ignored ? "Stop ignoring" : "Ignore…"}
          title={ignore.ignored ? "Stop ignoring" : "Ignore…"}
        >
          {ignore.ignored ? <BellIcon aria-hidden /> : <BellOffIcon aria-hidden />}
        </Button>
      )}
      {ignore.dialog}
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

/** J and K step through the list wherever focus is in the panel but a field; the Sheet takes Esc. */
function onPanelKeyDown(e: KeyboardEvent, panel: ReturnType<typeof useEnrichmentPanel>) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const key = e.key.toLowerCase();
  if (key === "j" || key === "k") {
    e.preventDefault();
    panel.step(key === "j" ? 1 : -1);
  }
}

export function EnrichmentPanel() {
  const panel = useEnrichmentPanel();
  const role = useQuery(meQuery).data?.organization?.role;
  const heading = useRef<HTMLHeadingElement>(null);
  const target = panel.current;

  if (!target) return null;
  return (
    <Sheet open onOpenChange={(open) => !open && panel.close()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full gap-0 overflow-y-auto overscroll-contain p-0 sm:w-[420px] sm:max-w-none"
        onKeyDown={(e) => onPanelKeyDown(e, panel)}
        // Focus goes to the heading, so Back, ↑ ↓ and ✕ are next; on closing, the provider returns it to the value it was opened from.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          heading.current?.focus();
        }}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <SheetDescription className="sr-only">What Argus's sources say about it</SheetDescription>
        <PanelFrameProvider value={{ nav: <Nav target={target} headingRef={heading} /> }}>
          <Content key={enrichmentKey(target)} target={target} admin={!!role && canManage(role)} />
        </PanelFrameProvider>
      </SheetContent>
    </Sheet>
  );
}
