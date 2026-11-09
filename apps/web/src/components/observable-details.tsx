import type { ObservableType } from "api/observables/vocabulary";
import type { ReactElement, ReactNode } from "react";
import { DomainHoverCard } from "@/components/domain-details";
import { HashHoverCard } from "@/components/hash-details";
import { IpHoverCard } from "@/components/ip-details";
import { ObservableMenu } from "@/components/observable-menu";
import { UrlHoverCard } from "@/components/url-details";
import { cn } from "@/lib/utils";

/**
 * The Observable types whose value opens a context popup on hover: IPs (IPinfo), hashes, domains,
 * email addresses and URLs (VirusTotal).
 */
export const hasContextPopup = (type: string) => ["ip", "md5", "sha1", "sha256", "domain", "email", "url"].includes(type);

/**
 * Wraps an Observable's value as it is shown anywhere so that hovering or focusing it opens its
 * context popup: what IPinfo says about an IP (`ip-details.tsx`, ADR 0010), what VirusTotal says
 * about a hash's file (`hash-details.tsx`, ADR 0011), or about a domain, an email address's domain
 * or a URL (`domain-details.tsx`, `url-details.tsx`, ADR 0012). Any other type, or `enabled` false,
 * leaves it as it is. `children` must be one element that can hold a ref.
 */
export function ObservableHoverCard({ type, value, enabled = true, children }: { type: ObservableType | string; value: string; enabled?: boolean; children: ReactElement }) {
  if (!enabled) return children;
  switch (type) {
    case "ip":
      return <IpHoverCard ip={value}>{children}</IpHoverCard>;
    case "md5":
    case "sha1":
    case "sha256":
      return <HashHoverCard hash={value}>{children}</HashHoverCard>;
    case "domain":
    case "email":
      return (
        <DomainHoverCard type={type} value={value}>
          {children}
        </DomainHoverCard>
      );
    case "url":
      return <UrlHoverCard url={value}>{children}</UrlHoverCard>;
    default:
      return children;
  }
}

/** Plain Observable text, focusable, with its context popup and the Observable menu. `children` is how it is shown. */
export function ObservableText({ type, value, className, children }: { type: ObservableType; value: string; className?: string; children: ReactNode }) {
  return (
    <ObservableHoverCard type={type} value={value}>
      <ObservableMenu observable={{ type, value }}>
        <span tabIndex={0} className={cn("font-mono text-xs underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className)}>
          {children}
        </span>
      </ObservableMenu>
    </ObservableHoverCard>
  );
}
