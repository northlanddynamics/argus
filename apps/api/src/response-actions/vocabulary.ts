/**
 * Response Actions (GLOSSARY.md, ADR 0007): what they are, where each stands, and what each kind
 * accepts. Plain values shared with the SPA.
 */

import type { ObservableType } from "../observables/vocabulary";

export const RESPONSE_ACTION_KINDS = ["falcon_ioc"] as const;
export type ResponseActionKind = (typeof RESPONSE_ACTION_KINDS)[number];
export const responseActionKindLabel: Record<ResponseActionKind, string> = { falcon_ioc: "Falcon custom IOC" };

/**
 * Where a Response Action stands:
 *
 * ```
 * Pending → Active   (sent)
 * Pending → Failed   (send attempts exhausted)
 * Failed  → Pending  (Retry)
 * ```
 *
 * Removing and Removed arrive with removal.
 */
export const RESPONSE_ACTION_STATES = ["pending", "active", "failed"] as const;
export type ResponseActionState = (typeof RESPONSE_ACTION_STATES)[number];
export const responseActionStateLabel: Record<ResponseActionState, string> = { pending: "Pending", active: "Active", failed: "Failed" };

/** What Falcon does when it sees the IOC: Prevent is for hashes only. */
export const FALCON_IOC_ACTIONS = ["detect", "prevent"] as const;
export type FalconIocAction = (typeof FALCON_IOC_ACTIONS)[number];
export const falconIocActionLabel: Record<FalconIocAction, string> = { detect: "Detect", prevent: "Prevent" };

/** Falcon's IOC types, as Argus sends them. */
export type FalconIocType = "sha256" | "md5" | "domain" | "ipv4" | "ipv6";

/**
 * The Falcon IOC type an Observable goes as, or null when Falcon takes no custom IOC of that type
 * (URLs, email addresses and SHA-1).
 */
export function falconIocType(type: ObservableType, value: string): FalconIocType | null {
  switch (type) {
    case "sha256":
    case "md5":
    case "domain":
      return type;
    case "ip":
      return value.includes(":") ? "ipv6" : "ipv4";
    default:
      return null;
  }
}

/** Whether Falcon lets an IOC of this type Prevent, not only Detect. */
export const falconAllowsPrevent = (type: FalconIocType) => type === "sha256" || type === "md5";
