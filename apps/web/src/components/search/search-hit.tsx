import { ItemContext, type ItemReference, itemReference } from "@/components/item-context";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AtSignIcon,
  BellOffIcon,
  FingerprintIcon,
  FolderIcon,
  GlobeIcon,
  HashIcon,
  LinkIcon,
  LockIcon,
  type LucideIcon,
  MonitorIcon,
  NetworkIcon,
  SirenIcon,
  UserIcon,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { SeverityBadge } from "@/components/case-badges";
import { alertStatusLabel } from "@/lib/alerts";
import { caseRef, statusLabel } from "@/lib/cases";
import { type AssetType, assetTypeLabel, defang, type ObservableType, observableTypeLabel } from "@/lib/observables";
import type { SearchHit } from "@/lib/search";
import { cn } from "@/lib/utils";

export const observableIcon: Record<ObservableType, LucideIcon> = {
  ip: NetworkIcon,
  domain: GlobeIcon,
  url: LinkIcon,
  email: AtSignIcon,
  md5: HashIcon,
  sha1: HashIcon,
  sha256: HashIcon,
};

export const assetIcon: Record<AssetType, LucideIcon> = { host: MonitorIcon, account: UserIcon };

/** One word of the kind, for lists that mix kinds. */
export const hitKindNoun: Record<SearchHit["kind"], string> = { cases: "Case", alerts: "Alert", observables: "Observable", assets: "Asset" };

/** The words of `query` that matches start with, lowercased. */
const wordsOf = (query: string) =>
  query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0 && w !== "or");

/** `text` with the parts that start with a word of `query` in bold. */
export function Highlighted({ text, query }: { text: string; query: string }) {
  const words = wordsOf(query);
  if (!words.length) return text;
  const pattern = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    i % 2 ? (
      <mark key={i} className="bg-transparent font-semibold text-foreground">
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/** Its kind's icon, and for Observables and Assets its type's. */
function HitIcon({ hit }: { hit: SearchHit }) {
  const className = "size-4 shrink-0 text-muted-foreground";
  switch (hit.kind) {
    case "cases":
      return <FolderIcon className={className} aria-hidden />;
    case "alerts":
      return <SirenIcon className={className} aria-hidden />;
    case "observables": {
      const Icon = observableIcon[hit.item.type] ?? FingerprintIcon;
      return <Icon className={className} aria-hidden />;
    }
    case "assets": {
      const Icon = assetIcon[hit.item.type] ?? FingerprintIcon;
      return <Icon className={className} aria-hidden />;
    }
  }
}

/**
 * Muted text in a result, a step darker on the highlighted row of the search box, where the row's
 * own grey fill would leave it short of 4.5:1.
 */
const mutedText = "text-muted-foreground group-data-[selected=true]/hit:text-foreground/75";

/** A result's detail line, led by "Ignored" when it is on the Organization's Ignored list. */
function IgnoredDetail({ ignored, text }: { ignored: boolean; text: string }) {
  if (!ignored) return text;
  return (
    <>
      <BellOffIcon className="mr-1 inline size-3 align-[-2px]" aria-hidden />
      Ignored · {text}
    </>
  );
}

const casesLine = (cases: { number: number }[]) => (cases.length ? cases.map((c) => caseRef(c.number)).join(", ") : "Named by an Alert");

/**
 * A result in one compact line: its kind's icon, what it is, a muted line of detail and, on the
 * right, how serious or where it is. `showKind` names the kind too, for lists that mix them.
 */
export function SearchHitRow({ hit, query, showKind = false }: { hit: SearchHit; query: string; showKind?: boolean }) {
  let title: ReactNode;
  let detail: ReactNode;
  let aside: ReactNode = null;
  switch (hit.kind) {
    case "cases": {
      const c = hit.item;
      title = (
        <>
          <span className={cn("font-mono text-xs", mutedText)}>{caseRef(c.number)}</span>{" "}
          <Highlighted text={c.title} query={query} />
          {c.restricted && <LockIcon className="ml-1 inline size-3 text-muted-foreground" aria-label="Restricted" />}
        </>
      );
      detail = statusLabel[c.status];
      aside = <SeverityBadge severity={c.severity} />;
      break;
    }
    case "alerts": {
      const a = hit.item;
      title = <Highlighted text={a.title} query={query} />;
      detail = [a.host, a.userName, a.integration.name].filter(Boolean).join(" · ");
      aside = (
        <>
          <span className={cn("hidden text-xs sm:inline", mutedText)}>{a.case ? caseRef(a.case.number) : alertStatusLabel[a.status]}</span>
          <SeverityBadge severity={a.severity} />
        </>
      );
      break;
    }
    case "observables": {
      const o = hit.item;
      title = (
        <span className="font-mono">
          <Highlighted text={defang(o.type, o.value)} query={query} />
        </span>
      );
      detail = <IgnoredDetail ignored={o.ignored} text={`${observableTypeLabel[o.type]} · ${casesLine(o.cases)}`} />;
      break;
    }
    case "assets": {
      const x = hit.item;
      title = (
        <span className="font-mono">
          <Highlighted text={x.value} query={query} />
        </span>
      );
      detail = <IgnoredDetail ignored={x.ignored} text={`${assetTypeLabel[x.type]} · ${casesLine(x.cases)}`} />;
      break;
    }
  }
  return (
    <div className="flex w-full min-w-0 items-center gap-3">
      <HitIcon hit={hit} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{title}</div>
        <div className={cn("truncate text-xs", mutedText)}>{detail}</div>
      </div>
      {(aside || showKind) && (
        <div className="flex shrink-0 items-center gap-2">
          {aside}
          {/* On a phone the icon shows the kind, and screen readers still hear it. */}
          {showKind && <span className={cn("sr-only w-16 text-right text-xs sm:not-sr-only sm:inline-block", mutedText)}>{hitKindNoun[hit.kind]}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Where a result opens: a Case's page; an Alert in the queue (for Guests, the Case it is on); an
 * Observable's or Asset's own page.
 */
function targetOf(hit: SearchHit, guest: boolean) {
  switch (hit.kind) {
    case "cases":
      return { to: "/cases/$number", params: { number: String(hit.item.number) } } as const;
    case "alerts":
      return guest && hit.item.case
        ? ({ to: "/cases/$number", params: { number: String(hit.item.case.number) } } as const)
        : ({ to: "/alerts", search: { status: "any", alert: hit.item.id } } as const);
    case "observables":
      return { to: "/observables/$id", params: { id: hit.item.id } } as const;
    case "assets":
      return { to: "/assets/$id", params: { id: hit.item.id } } as const;
  }
}

/** Opens a result, for keyboard selection. */
export function useOpenHit(guest: boolean) {
  const navigate = useNavigate();
  return (hit: SearchHit) => {
    const target = targetOf(hit, guest);
    if (target.to === "/alerts") return navigate({ to: target.to, search: target.search });
    return navigate({ to: target.to, params: target.params });
  };
}

/** An Observable or Asset result as a reference, for its hover card, Enrichment and right-click menu. */
export const hitItem = (hit: SearchHit): ItemReference | null =>
  hit.kind === "observables" ? itemReference("observable", hit.item) : hit.kind === "assets" ? itemReference("asset", hit.item) : null;

/** A result as a link to where it opens; an Observable's or Asset's has what `ItemContext` gives it. */
export function SearchHitLink({ hit, guest, className, children }: { hit: SearchHit; guest: boolean; className?: string; children: ReactNode }) {
  const target = targetOf(hit, guest);
  const classes = cn("block rounded-md px-2 py-1.5 outline-none hover:bg-muted focus-visible:bg-muted", className);
  return (
    <ItemContext item={hitItem(hit)}>
      {target.to === "/alerts" ? (
        <Link to={target.to} search={target.search} className={classes}>
          {children}
        </Link>
      ) : (
        <Link to={target.to} params={target.params} className={classes}>
          {children}
        </Link>
      )}
    </ItemContext>
  );
}
