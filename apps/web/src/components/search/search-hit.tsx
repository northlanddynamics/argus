import { Link, useNavigate } from "@tanstack/react-router";
import {
  AtSignIcon,
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
import { assetTypeLabel, defang, type ObservableType, observableTypeLabel } from "@/lib/observables";
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
    case "assets":
      return hit.item.type === "host" ? <MonitorIcon className={className} aria-hidden /> : <UserIcon className={className} aria-hidden />;
  }
}

const casesLine = (cases: { number: number }[]) => (cases.length ? cases.map((c) => caseRef(c.number)).join(", ") : "Named by an Alert");

/**
 * A result in one compact line: its kind's icon, what it is, a muted line of detail and, on the
 * right, how serious or where it is. `showKind` names the kind too, for lists that mix them.
 */
export function SearchHitRow({ hit, query, showKind = false }: { hit: SearchHit; query: string; showKind?: boolean }) {
  let title: ReactNode;
  let detail: string;
  let aside: ReactNode = null;
  switch (hit.kind) {
    case "cases": {
      const c = hit.item;
      title = (
        <>
          <span className="font-mono text-xs text-muted-foreground">{caseRef(c.number)}</span>{" "}
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
          <span className="hidden text-xs text-muted-foreground sm:inline">{a.case ? caseRef(a.case.number) : alertStatusLabel[a.status]}</span>
          <SeverityBadge severity={a.severity} />
        </>
      );
      break;
    }
    case "observables": {
      const o = hit.item;
      title = (
        <span className="font-mono text-[0.8125rem]">
          <Highlighted text={defang(o.type, o.value)} query={query} />
        </span>
      );
      detail = `${observableTypeLabel[o.type]} · ${casesLine(o.cases)}`;
      break;
    }
    case "assets": {
      const x = hit.item;
      title = (
        <span className="font-mono text-[0.8125rem]">
          <Highlighted text={x.value} query={query} />
        </span>
      );
      detail = `${assetTypeLabel[x.type]} · ${casesLine(x.cases)}`;
      break;
    }
  }
  return (
    <div className="flex w-full min-w-0 items-center gap-3">
      <HitIcon hit={hit} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{detail}</div>
      </div>
      {(aside || showKind) && (
        <div className="flex shrink-0 items-center gap-2">
          {aside}
          {showKind && <span className="hidden w-16 text-right text-xs text-muted-foreground sm:inline-block">{hitKindNoun[hit.kind]}</span>}
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

/** A result as a link to where it opens. */
export function SearchHitLink({ hit, guest, className, children }: { hit: SearchHit; guest: boolean; className?: string; children: ReactNode }) {
  const target = targetOf(hit, guest);
  const classes = cn("block rounded-md px-2 py-1.5 outline-none hover:bg-muted focus-visible:bg-muted", className);
  if (target.to === "/alerts") {
    return (
      <Link to={target.to} search={target.search} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <Link to={target.to} params={target.params} className={classes}>
      {children}
    </Link>
  );
}
