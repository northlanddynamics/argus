/**
 * Response Actions (GLOSSARY.md, ADR 0007): what they are, where each stands, and what each kind
 * accepts. Plain values shared with the SPA.
 */

import type { Severity } from "../cases/vocabulary";
import type { ActionProvider } from "../integrations/vocabulary";
import type { ObservableType } from "../observables/vocabulary";

/**
 * `falcon_ioc` and `mimecast_blocked_sender` are taken against an Observable; `falcon_containment`
 * against a host Asset, one Falcon device (`aid`) of it (ADR 0009). So is `falcon_containment_lift`:
 * an Admin lifting containment that Argus didn't impose, which is never removed or dismissed.
 */
export const RESPONSE_ACTION_KINDS = ["falcon_ioc", "mimecast_blocked_sender", "falcon_containment", "falcon_containment_lift"] as const;
export type ResponseActionKind = (typeof RESPONSE_ACTION_KINDS)[number];
export const responseActionKindLabel: Record<ResponseActionKind, string> = {
  falcon_ioc: "Falcon custom IOC",
  mimecast_blocked_sender: "Mimecast blocked sender",
  falcon_containment: "Falcon host containment",
  falcon_containment_lift: "Falcon containment lift",
};

/** The kinds taken against a host Asset, and through a CrowdStrike Integration's Host containment setting. */
export const HOST_KINDS = ["falcon_containment", "falcon_containment_lift"] as const satisfies readonly ResponseActionKind[];
export const isHostKind = (kind: ResponseActionKind) => (HOST_KINDS as readonly string[]).includes(kind);

/** What a containment Response Action targets in Falcon: one device, by `aid`. */
export const CONTAINMENT_TARGET_TYPE = "device";

/** The kind of Response Action each Provider takes against an Observable. */
export const providerKind: Record<ActionProvider, ResponseActionKind> = { crowdstrike: "falcon_ioc", mimecast: "mimecast_blocked_sender" };

/**
 * Where a Response Action stands:
 *
 * ```
 * Pending  → Active    (sent, or found already in the tool: for containment, the host already contained)
 * Pending  → Failed    (send attempts exhausted)
 * Failed   → Pending   (Retry, when sending failed)
 * Active   → Removing  (Remove, only one Argus created)
 * Removing → Removed   (the tool deleted it, or says it is already gone)
 * Removing → Failed    (remove attempts exhausted)
 * Failed   → Removing  (Retry, when removing failed)
 * Active   → Removed   (an "already present" record dismissed, or the one it relies on removed)
 * Active   → Removed   (containment only: Falcon shows the host released, "lifted in Falcon")
 * Active   → Removed   (containment only: an Admin's Lift containment lifted it, from any Case)
 * ```
 *
 * A Lift containment goes Pending → Active (lifted, or found already released) or Failed, and Failed
 * → Pending on Retry; it is never removed or dismissed.
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

/**
 * What Mimecast does: block the email address itself, or every sender at its domain, through an
 * Organization-wide Blocked Senders policy entry.
 */
export const MIMECAST_ACTIONS = ["block_sender", "block_domain"] as const;
export type MimecastAction = (typeof MIMECAST_ACTIONS)[number];
export const mimecastActionLabel: Record<MimecastAction, string> = { block_sender: "Block sender", block_domain: "Block domain" };

/** Every action a Response Action can be taken with, whatever its Provider. */
export const RESPONSE_ACTION_ACTIONS = [...FALCON_IOC_ACTIONS, ...MIMECAST_ACTIONS] as const;
export type ResponseActionAction = (typeof RESPONSE_ACTION_ACTIONS)[number];
export const responseActionActionLabel: Record<ResponseActionAction, string> = { ...falconIocActionLabel, ...mimecastActionLabel };

/** The actions each Provider takes. */
export const providerActions: Record<ActionProvider, readonly ResponseActionAction[]> = { crowdstrike: FALCON_IOC_ACTIONS, mimecast: MIMECAST_ACTIONS };

/** What a Mimecast Blocked Senders entry blocks. */
export type MimecastTargetType = "email" | "domain";

/**
 * What Mimecast is sent for an Observable: its address, or its address's domain, in lowercase as
 * they are held. Null for anything but an email address.
 */
export function mimecastTarget(type: ObservableType, key: string, action: MimecastAction): { type: MimecastTargetType; value: string } | null {
  if (type !== "email") return null;
  return action === "block_sender" ? { type: "email", value: key } : { type: "domain", value: key.slice(key.lastIndexOf("@") + 1) };
}

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

/** The platforms a Falcon custom IOC can apply to. */
export const FALCON_IOC_PLATFORMS = ["windows", "mac", "linux"] as const;
export type FalconIocPlatform = (typeof FALCON_IOC_PLATFORMS)[number];
export const falconIocPlatformLabel: Record<FalconIocPlatform, string> = { windows: "Windows", mac: "macOS", linux: "Linux" };

/**
 * What a Falcon custom IOC is sent with besides its action, set per Integration by an Admin so that
 * a Member can take one in a single click (ADR 0008). `severity` is a fixed Severity, or `case` to
 * follow the Case's; `platforms` is at least one; `internal` is whether a Response Action starts
 * hidden from the Case's Guests.
 */
export type FalconIocDefaults = {
  severity: "case" | Severity;
  platforms: FalconIocPlatform[];
  internal: boolean;
};

/** As ADR 0007 had it: severity from the Case, every platform, visible to Guests. */
export const DEFAULT_FALCON_IOC_DEFAULTS: FalconIocDefaults = { severity: "case", platforms: [...FALCON_IOC_PLATFORMS], internal: false };

/** The severity an IOC goes with: the Integration's own, or the Case's. */
export const iocSeverity = (defaults: FalconIocDefaults, caseSeverity: Severity): Severity =>
  defaults.severity === "case" ? caseSeverity : defaults.severity;
