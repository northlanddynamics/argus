/**
 * Integration Providers (ADR 0007): the external tool an Integration connects to, which fixes what
 * it can do. Nothing outside this file should assume an Integration has an Alert stream; check its
 * Provider's capabilities instead.
 */

export const PROVIDERS = ["crowdstrike", "mimecast", "ipinfo", "umbrella"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const providerLabel: Record<Provider, string> = { crowdstrike: "CrowdStrike", mimecast: "Mimecast", ipinfo: "IPinfo", umbrella: "Cisco Umbrella" };

export type ProviderCapabilities = {
  /** Receives Alerts from the tool's event stream. */
  receivesAlerts: boolean;
  /** Writes changes made to its Alerts back to the tool (ADR 0002). */
  writesBack: boolean;
  /** Takes Response Actions in the tool from a Case. */
  responseActions: boolean;
  /** Looks up what is known about an IP address (ADR 0010); at most one such Integration per Organization. */
  looksUpIps: boolean;
  /** Says which of the tool's destination lists hold a domain (ADR 0014). */
  checksDomains: boolean;
};

export const providerCapabilities: Record<Provider, ProviderCapabilities> = {
  crowdstrike: { receivesAlerts: true, writesBack: true, responseActions: true, looksUpIps: false, checksDomains: false },
  mimecast: { receivesAlerts: false, writesBack: false, responseActions: true, looksUpIps: false, checksDomains: false },
  ipinfo: { receivesAlerts: false, writesBack: false, responseActions: false, looksUpIps: true, checksDomains: false },
  umbrella: { receivesAlerts: false, writesBack: false, responseActions: true, looksUpIps: false, checksDomains: true },
};

/** The Providers that can do `capability`. */
export const providersThat = (capability: keyof ProviderCapabilities) => PROVIDERS.filter((p) => providerCapabilities[p][capability]);

/** The Providers whose Integrations take Response Actions. */
export type ActionProvider = Exclude<Provider, "ipinfo">;
