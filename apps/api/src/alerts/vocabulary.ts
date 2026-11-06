/** The fixed lists an Alert and an Integration are described with (GLOSSARY.md), as stored codes and their display names. */

/** Where an Alert stands. Every Alert starts New. */
export const ALERT_STATUSES = ["new", "attached", "dismissed"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];
export const alertStatusLabel: Record<AlertStatus, string> = { new: "New", attached: "Attached", dismissed: "Dismissed" };

/** Why an Alert was dismissed without being attached to a Case. */
export const DISMISSAL_REASONS = ["false_positive", "benign", "duplicate", "other"] as const;
export type DismissalReason = (typeof DISMISSAL_REASONS)[number];
export const dismissalReasonLabel: Record<DismissalReason, string> = {
  false_positive: "False Positive",
  benign: "Benign",
  duplicate: "Duplicate",
  other: "Other",
};

/** An Alert's status in Falcon, which Argus mirrors but does not own: it is not its Alert Status. */
export const falconStatusLabel: Record<string, string> = { new: "New", in_progress: "In Progress", reopened: "Reopened", closed: "Closed" };

/**
 * What Argus writes back to Falcon about an Alert (ADR 0002), each the result of something done in
 * Argus: attaching it to a Case, dismissing it, closing its Case, or changing its Case's Assignee.
 */
export const WRITE_BACK_ACTIONS = ["attach", "dismiss", "case_close", "assign"] as const;
export type WriteBackAction = (typeof WRITE_BACK_ACTIONS)[number];

/**
 * Where a write-back stands. `pending`: waiting to be sent, or to be retried after a failure.
 * `sent`: Falcon accepted it. `skipped`: there was nothing to send (no Falcon user matches the
 * Assignee's email). `cancelled`: write-back was turned off before it was sent. `failed`: Falcon
 * kept refusing it, and Argus gave up.
 */
export const WRITE_BACK_STATES = ["pending", "sent", "skipped", "cancelled", "failed"] as const;
export type WriteBackState = (typeof WRITE_BACK_STATES)[number];

/** How CrowdStrike is named in Audit Logs for a change made in Falcon by `user`. */
export const crowdstrikeActorName = (user: string | null) => (user ? `CrowdStrike (Falcon: ${user})` : "CrowdStrike");

/** How the author of a comment made in Falcon, synced into a Discussion, is shown. */
export const falconAuthorName = (author: string | null) => (author ? `CrowdStrike: ${author}` : "CrowdStrike");

/** How an Alert is named in Audit Logs: its detection's title and Falcon's id for it. */
export const alertLabel = (a: { title: string; externalId: string }) => `${a.title} (${a.externalId})`;

/** Which kind of CrowdStrike detection an Alert came from: endpoint, identity or mobile. */
export const ALERT_KINDS = ["epp", "idp", "mobile"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const alertKindLabel: Record<AlertKind, string> = { epp: "Endpoint detection", idp: "Identity detection", mobile: "Mobile detection" };

/** The Falcon clouds an Integration can connect to, with their API base URLs. */
export const FALCON_CLOUDS = ["us-1", "us-2", "eu-1", "us-gov-1"] as const;
export type FalconCloud = (typeof FALCON_CLOUDS)[number];
export const falconCloudLabel: Record<FalconCloud, string> = { "us-1": "US-1", "us-2": "US-2", "eu-1": "EU-1", "us-gov-1": "US-GOV-1" };

/** Each cloud's Falcon console. */
const FALCON_CONSOLES: Record<FalconCloud, string> = {
  "us-1": "https://falcon.crowdstrike.com",
  "us-2": "https://falcon.us-2.crowdstrike.com",
  "eu-1": "https://falcon.eu-1.crowdstrike.com",
  "us-gov-1": "https://falcon.laggar.gcw.crowdstrike.com",
};

/** Device `deviceId` (an `aid`) in the Falcon console of `cloud`. */
export const falconDeviceUrl = (cloud: FalconCloud, deviceId: string) => `${FALCON_CONSOLES[cloud]}/hosts/hosts/host/${encodeURIComponent(deviceId)}`;

/**
 * How an Integration's Event Streams connection is doing, as its worker last reported it.
 * `connecting`: waiting for a worker to (re)connect. `connected`: the stream is open.
 * `disconnected`: the stream dropped; a worker reconnects from the stored offset. `error`: Falcon
 * refused or failed, with the reason in the Integration's health detail.
 */
export const INTEGRATION_HEALTH = ["connecting", "connected", "disconnected", "error"] as const;
export type IntegrationHealth = (typeof INTEGRATION_HEALTH)[number];
export const integrationHealthLabel: Record<IntegrationHealth, string> = {
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Reconnecting",
  error: "Error",
};
