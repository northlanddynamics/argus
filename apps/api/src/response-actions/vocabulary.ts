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
 * Pending  → Active    (sent, or found already in the tool)
 * Pending  → Failed    (send attempts exhausted)
 * Failed   → Pending   (Retry, when sending failed)
 * Active   → Removing  (Remove, only one Argus created)
 * Removing → Removed   (the tool deleted it, or says it is already gone)
 * Removing → Failed    (remove attempts exhausted)
 * Failed   → Removing  (Retry, when removing failed)
 * Active   → Removed   (an "already present" record dismissed, or the one it relies on removed)
 * ```
 *
 * A Response Action recorded as already sent from another Case starts Active.
 */
export const RESPONSE_ACTION_STATES = ["pending", "active", "removing", "failed", "removed"] as const;
export type ResponseActionState = (typeof RESPONSE_ACTION_STATES)[number];
export const responseActionStateLabel: Record<ResponseActionState, string> = {
  pending: "Pending",
  active: "Active",
  removing: "Removing",
  failed: "Failed",
  removed: "Removed",
};

/**
 * Where a Response Action came from:
 *
 * - `created`: Argus creates it in the tool (or will, while Pending or Failed).
 * - `already_present`: Argus had already sent the same thing to the same Integration, from this or
 *   another Case; nothing was sent, and the record points at that Response Action.
 * - `in_tool`: the tool already held it when Argus looked before creating; nothing was written.
 *
 * Argus only ever removes what it created; the other two can only be dismissed from their Case.
 */
export const RESPONSE_ACTION_ORIGINS = ["created", "already_present", "in_tool"] as const;
export type ResponseActionOrigin = (typeof RESPONSE_ACTION_ORIGINS)[number];

/**
 * The states in which a created Response Action holds its Integration, kind and value: no other may
 * be created for them. So does a Failed one whose removal failed, since the tool still holds it.
 */
export const LIVE_STATES = ["pending", "active", "removing"] as const satisfies readonly ResponseActionState[];

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
