import {
  type AssetType,
  type Normalised,
  normaliseAsset,
  normaliseObservable,
  type ObservableType,
} from "../observables/vocabulary";

/**
 * The Observables and Assets a CrowdStrike detection names, read from its event as Falcon sends it.
 * Endpoint (EPP), identity (IdP) and mobile detections name them in different fields; values that
 * aren't valid for their type, and Falcon's placeholders (an all-zero hash, `0.0.0.0`), are left out.
 */

export type Extracted<Type extends string> = Normalised & { type: Type };
export type Indicators = { observables: Extracted<ObservableType>[]; assets: Extracted<AssetType>[] };

/** The most of each that one detection contributes, so a runaway payload can't flood a Case. */
const MAX_PER_DETECTION = 100;

/**
 * Fields naming an Observable, wherever they appear in the event (detections nest them in lists such
 * as `NetworkAccesses`, `DnsRequests` and `MobileAppsDetails`). A host's own addresses (`LocalIP`,
 * `LocalAddress`, `ExternalIP`) describe the Asset, not the threat, so they aren't read.
 */
function observableField(key: string): ObservableType | null {
  if (/sha-?256/i.test(key)) return "sha256";
  if (/sha-?1(?!\d)/i.test(key)) return "sha1";
  if (/md5/i.test(key)) return "md5";
  if (/^(RemoteAddress|RemoteIP|SourceEndpointIpAddress|SourceIp)$/i.test(key)) return "ip";
  if (/^DomainName$/i.test(key)) return "domain";
  return null;
}

/** Falcon's `IOCType` for the `IOCValue` beside it. */
const IOC_TYPES: Record<string, ObservableType> = {
  hash_sha256: "sha256",
  hash_sha1: "sha1",
  hash_md5: "md5",
  domain: "domain",
  ipv4: "ip",
  ipv6: "ip",
  url: "url",
};

/** Hosts, in the order they are preferred. */
const HOST_FIELDS = ["Hostname", "HostName", "ComputerName", "DeviceName", "SourceEndpointHostName", "TargetEndpointHostName"];

/** Accounts: each entry is one account, named by the first of its fields that is set. */
const ACCOUNT_FIELDS = [
  ["UserName"],
  ["UserPrincipal"],
  ["SourceAccountName", "SourceAccountSamAccountName", "SourceAccountUpn"],
  ["TargetAccountName", "TargetAccountSamAccountName", "TargetAccountUpn"],
];

/** Placeholders Falcon sends when it has no value. */
const placeholder = (type: ObservableType, value: string) =>
  (type === "md5" || type === "sha1" || type === "sha256" ? /^0+$/.test(value) : false) ||
  (type === "ip" && ["0.0.0.0", "::", "127.0.0.1", "::1"].includes(value));

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

function collector<Type extends string>() {
  const found = new Map<string, Extracted<Type>>();
  return {
    add(type: Type, normalised: Normalised | null) {
      const key = `${type}\u0000${normalised?.key}`;
      if (!normalised || found.has(key) || found.size >= MAX_PER_DETECTION) return;
      found.set(key, { type, ...normalised });
    },
    get list() {
      return [...found.values()];
    },
  };
}

export function extractIndicators(event: Record<string, unknown>): Indicators {
  const observables = collector<ObservableType>();
  const assets = collector<AssetType>();

  const addObservable = (type: ObservableType, raw: unknown) => {
    const value = text(raw);
    if (!value) return;
    const normalised = normaliseObservable(type, value);
    if (normalised && !placeholder(type, normalised.value)) observables.add(type, normalised);
  };

  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const iocType = text(record.IOCType)?.toLowerCase();
    if (iocType && IOC_TYPES[iocType]) addObservable(IOC_TYPES[iocType], record.IOCValue);
    for (const [key, value] of Object.entries(record)) {
      const type = observableField(key);
      if (type) addObservable(type, value);
      else walk(value, depth + 1);
    }
  };
  walk(event, 0);

  for (const field of HOST_FIELDS) {
    const value = text(event[field]);
    if (value) assets.add("host", normaliseAsset("host", value));
  }
  for (const fields of ACCOUNT_FIELDS) {
    const value = fields.map((f) => text(event[f])).find((v) => v !== null);
    if (value) assets.add("account", normaliseAsset("account", value));
  }

  return { observables: observables.list, assets: assets.list };
}
