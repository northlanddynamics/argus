/** The fixed lists an Alert and an Integration are described with (GLOSSARY.md), as stored codes and their display names. */

/** Where an Alert stands. Every Alert starts New. */
export const ALERT_STATUSES = ["new", "attached", "dismissed"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];
export const alertStatusLabel: Record<AlertStatus, string> = { new: "New", attached: "Attached", dismissed: "Dismissed" };

/** Which kind of CrowdStrike detection an Alert came from: endpoint, identity or mobile. */
export const ALERT_KINDS = ["epp", "idp", "mobile"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const alertKindLabel: Record<AlertKind, string> = { epp: "Endpoint detection", idp: "Identity detection", mobile: "Mobile detection" };

/** The Falcon clouds an Integration can connect to, with their API base URLs. */
export const FALCON_CLOUDS = ["us-1", "us-2", "eu-1", "us-gov-1"] as const;
export type FalconCloud = (typeof FALCON_CLOUDS)[number];
export const falconCloudLabel: Record<FalconCloud, string> = { "us-1": "US-1", "us-2": "US-2", "eu-1": "EU-1", "us-gov-1": "US-GOV-1" };

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
