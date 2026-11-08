import type { ObservableType } from "api/observables/vocabulary";
import type { ReactElement } from "react";
import { HashHoverCard } from "@/components/hash-details";
import { IpHoverCard } from "@/components/ip-details";

/** The Observable types whose value opens a context popup on hover: IPs (IPinfo) and hashes (VirusTotal). */
export const hasContextPopup = (type: string) => type === "ip" || type === "md5" || type === "sha1" || type === "sha256";

/**
 * Wraps an Observable's value as it is shown anywhere so that hovering or focusing it opens its
 * context popup: what IPinfo says about an IP (`ip-details.tsx`, ADR 0010), or what VirusTotal says
 * about a hash's file (`hash-details.tsx`, ADR 0011). Any other type, or `enabled` false, leaves it
 * as it is. `children` must be one element that can hold a ref.
 */
export function ObservableHoverCard({ type, value, enabled = true, children }: { type: ObservableType | string; value: string; enabled?: boolean; children: ReactElement }) {
  if (!enabled) return children;
  if (type === "ip") return <IpHoverCard ip={value}>{children}</IpHoverCard>;
  if (hasContextPopup(type)) return <HashHoverCard hash={value}>{children}</HashHoverCard>;
  return children;
}
