/**
 * The Action Center and its Action Log (GLOSSARY.md, ADR 0016): what can be run, and what the log
 * records. Plain values shared with the SPA.
 */

import type { ObservableType } from "../observables/vocabulary";

/**
 * What the Action Center can run. The Response Actions are those of ADR 0007 by their action (Falcon's
 * Detect and Prevent, Mimecast's Block sender and Block domain, Umbrella's Add to destination list),
 * plus containment (ADR 0009), which the Action Center hands to a Case's confirmation. The lookups are
 * those of ADRs 0010–0012 and 0014, and the marks those of ADR 0015 and the Ignored list.
 */
export const CENTER_ACTIONS = [
  "detect",
  "prevent",
  "block_sender",
  "block_domain",
  "add_to_destination_list",
  "contain",
  "lift_containment",
  "ip_lookup",
  "hash_lookup",
  "domain_url_lookup",
  "umbrella_check",
  "mark_important",
  "ignore",
] as const;
export type CenterAction = (typeof CENTER_ACTIONS)[number];

/**
 * How an action changes things: in a tool (removable), nowhere (reads), or in how Argus treats a
 * value; or a Falcon Fusion SOAR Workflow run (ADR 0017), which does whatever the Workflow does.
 */
export type CenterGroup = "respond" | "lookup" | "mark" | "workflow";

export const centerActionLabel: Record<CenterAction, string> = {
  detect: "IOC alert",
  prevent: "IOC block",
  block_sender: "Block sender",
  block_domain: "Block domain",
  add_to_destination_list: "Add to destination list",
  contain: "Contain host",
  lift_containment: "Lift containment",
  ip_lookup: "IP details",
  hash_lookup: "File reputation",
  domain_url_lookup: "Domain & URL reputation",
  umbrella_check: "Destination list check",
  mark_important: "Mark Important",
  ignore: "Ignore",
};

export const centerActionGroup: Record<CenterAction, CenterGroup> = {
  detect: "respond",
  prevent: "respond",
  block_sender: "respond",
  block_domain: "respond",
  add_to_destination_list: "respond",
  contain: "respond",
  lift_containment: "respond",
  ip_lookup: "lookup",
  hash_lookup: "lookup",
  domain_url_lookup: "lookup",
  umbrella_check: "lookup",
  mark_important: "mark",
  ignore: "mark",
};

/** The Observable types each action takes; containment takes a host, by name, instead. */
export const centerActionAccepts: Record<CenterAction, readonly (ObservableType | "host")[]> = {
  detect: ["sha256", "md5", "domain", "ip"],
  prevent: ["sha256", "md5"],
  block_sender: ["email"],
  block_domain: ["email"],
  add_to_destination_list: ["domain"],
  contain: ["host"],
  lift_containment: ["host"],
  ip_lookup: ["ip"],
  hash_lookup: ["sha256", "sha1", "md5"],
  domain_url_lookup: ["domain", "url", "email"],
  umbrella_check: ["domain", "email"],
  mark_important: ["ip", "domain", "url", "email", "md5", "sha1", "sha256"],
  ignore: ["ip", "domain", "url", "email", "md5", "sha1", "sha256"],
};

/** The Response Actions the Action Center takes itself, by their ADR 0007 action. */
export const CENTER_RESPONSE_ACTIONS = ["detect", "prevent", "block_sender", "block_domain", "add_to_destination_list"] as const;
export type CenterResponseAction = (typeof CENTER_RESPONSE_ACTIONS)[number];
export const isCenterResponseAction = (a: CenterAction): a is CenterResponseAction => (CENTER_RESPONSE_ACTIONS as readonly string[]).includes(a);

/** The lookups the Action Center runs. */
export const CENTER_LOOKUPS = ["ip_lookup", "hash_lookup", "domain_url_lookup", "umbrella_check"] as const;
export type CenterLookup = (typeof CENTER_LOOKUPS)[number];
export const isCenterLookup = (a: CenterAction): a is CenterLookup => (CENTER_LOOKUPS as readonly string[]).includes(a);

/** The longest reason a Response Action without a Case may give. */
export const REASON_MAX_LENGTH = 500;

/**
 * What an Action Log row records. A `response_action` row points at its Response Action, and a
 * `workflow_run` row at its Workflow Run (ADR 0017), whose state each shows; the others record a mark
 * or a lookup and how it went.
 */
export const LOG_ACTIONS = [
  "response_action",
  "workflow_run",
  "mark_important",
  "unmark_important",
  "ignore",
  "unignore",
  "ip_lookup",
  "hash_lookup",
  "domain_lookup",
  "url_lookup",
  "umbrella_check",
] as const;
export type LogAction = (typeof LOG_ACTIONS)[number];
export const logActionLabel: Record<LogAction, string> = {
  response_action: "Response Action",
  workflow_run: "Workflow",
  mark_important: "Mark Important",
  unmark_important: "Unmark Important",
  ignore: "Ignore",
  unignore: "Stop ignoring",
  ip_lookup: "IP details",
  hash_lookup: "File reputation",
  domain_lookup: "Domain reputation",
  url_lookup: "URL reputation",
  umbrella_check: "Destination list check",
};
export const logActionGroup: Record<LogAction, CenterGroup> = {
  response_action: "respond",
  workflow_run: "workflow",
  mark_important: "mark",
  unmark_important: "mark",
  ignore: "mark",
  unignore: "mark",
  ip_lookup: "lookup",
  hash_lookup: "lookup",
  domain_lookup: "lookup",
  url_lookup: "lookup",
  umbrella_check: "lookup",
};

/** Where an action was run from. */
export const LOG_SOURCES = ["action_center", "case", "elsewhere"] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
export const logSourceLabel: Record<LogSource, string> = { action_center: "Action Center", case: "Case", elsewhere: "Elsewhere in Argus" };

/**
 * How a mark or lookup went: `done`; `cached`, a lookup answered from what Argus already held;
 * `unchanged`, a mark that was already so; `failed`, with why in `detail`.
 */
export const LOG_OUTCOMES = ["done", "cached", "unchanged", "failed"] as const;
export type LogOutcome = (typeof LOG_OUTCOMES)[number];
export const logOutcomeLabel: Record<LogOutcome, string> = { done: "Done", cached: "Cached", unchanged: "No change", failed: "Failed" };
