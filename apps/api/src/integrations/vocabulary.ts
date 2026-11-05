/**
 * Integration Providers (ADR 0007): the external tool an Integration connects to, which fixes what
 * it can do. Nothing outside this file should assume an Integration has an Alert stream; check its
 * Provider's capabilities instead.
 */

export const PROVIDERS = ["crowdstrike", "mimecast"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const providerLabel: Record<Provider, string> = { crowdstrike: "CrowdStrike", mimecast: "Mimecast" };

export type ProviderCapabilities = {
  /** Receives Alerts from the tool's event stream. */
  receivesAlerts: boolean;
  /** Writes changes made to its Alerts back to the tool (ADR 0002). */
  writesBack: boolean;
  /** Takes Response Actions in the tool from a Case. */
  responseActions: boolean;
};

export const providerCapabilities: Record<Provider, ProviderCapabilities> = {
  crowdstrike: { receivesAlerts: true, writesBack: true, responseActions: true },
  mimecast: { receivesAlerts: false, writesBack: false, responseActions: true },
};

/** The Providers that can do `capability`. */
export const providersThat = (capability: keyof ProviderCapabilities) => PROVIDERS.filter((p) => providerCapabilities[p][capability]);
