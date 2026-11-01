/**
 * The kinds of Observable and Asset (GLOSSARY.md), and how a value is normalised so that each is held
 * once per Organization. Plain functions on strings, shared with the SPA, so no runtime-specific APIs.
 */

export const OBSERVABLE_TYPES = ["ip", "domain", "url", "email", "md5", "sha1", "sha256"] as const;
export type ObservableType = (typeof OBSERVABLE_TYPES)[number];
export const observableTypeLabel: Record<ObservableType, string> = {
  ip: "IP",
  domain: "Domain",
  url: "URL",
  email: "Email",
  md5: "MD5",
  sha1: "SHA-1",
  sha256: "SHA-256",
};

export const ASSET_TYPES = ["host", "account"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
export const assetTypeLabel: Record<AssetType, string> = { host: "Host", account: "Account" };

/**
 * A value as it is shown, and the key it is held under: two values with the same type and key are
 * the same Observable (or Asset).
 */
export type Normalised = { value: string; key: string };

/** Undoes the usual defanging: `hxxp://evil[.]example`, `user[@]evil[.]example`. */
const refang = (raw: string) =>
  raw
    .trim()
    .replace(/\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\)/gi, ".")
    .replace(/\[@\]|\(@\)|\[at\]|\(at\)/gi, "@")
    .replace(/\[:\]/g, ":")
    .replace(/^hxxp(s?)/i, "http$1")
    .replace(/^fxp/i, "ftp");

/** Dotted-quad IPv4 with each part 0–255, written without leading zeros; else null. */
function ipv4(s: string) {
  const parts = s.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.map(Number).join(".");
}

/** IPv6 in its canonical form (lowercase, zeros compressed); else null. */
function ipv6(s: string) {
  if (!s.includes(":") || !/^[0-9a-f:.]+$/i.test(s)) return null;
  try {
    return new URL(`http://[${s}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/** A host name in lowercase ASCII (international names as punycode), without a trailing dot; else null. */
function domain(s: string) {
  const name = s.toLowerCase().replace(/\.$/, "");
  if (!name || /[\s/:@?#\\[\]]/.test(name) || ipv4(name)) return null;
  let ascii: string;
  try {
    ascii = new URL(`http://${name}/`).hostname;
  } catch {
    return null;
  }
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  const labels = ascii.split(".");
  if (ascii.length > 253 || labels.length < 2 || !labels.every((l) => label.test(l)) || /^\d+$/.test(labels.at(-1) ?? "")) {
    return null;
  }
  return ascii;
}

const hex = (length: number) => (s: string) => {
  const h = s.replace(/\s/g, "").toLowerCase();
  return new RegExp(`^[0-9a-f]{${length}}$`).test(h) ? h : null;
};

const observableNormalisers: Record<ObservableType, (s: string) => string | null> = {
  ip: (s) => ipv4(s) ?? ipv6(s),
  domain,
  url(s) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if (!["http:", "https:", "ftp:"].includes(url.protocol) || !url.hostname) return null;
    return url.href;
  },
  email(s) {
    const at = s.lastIndexOf("@");
    const local = s.slice(0, at);
    const host = domain(s.slice(at + 1));
    if (at < 1 || local.length > 64 || /[\s@<>()[\]\\,;:"]/.test(local) || !host) return null;
    return `${local.toLowerCase()}@${host}`;
  },
  md5: hex(32),
  sha1: hex(40),
  sha256: hex(64),
};

const observableExample: Record<ObservableType, string> = {
  ip: "an IPv4 or IPv6 address",
  domain: "a domain name",
  url: "an http, https or ftp URL",
  email: "an email address",
  md5: "32 hexadecimal digits",
  sha1: "40 hexadecimal digits",
  sha256: "64 hexadecimal digits",
};

/**
 * An Observable's value in its one canonical form, which is also its key: IPs without leading zeros
 * or with IPv6 zeros compressed, domains and email addresses in lowercase, URLs as the browser would
 * write them, hashes in lowercase hex. Defanged values are accepted. Null if it isn't a valid `type`.
 */
export function normaliseObservable(type: ObservableType, raw: string): Normalised | null {
  const value = observableNormalisers[type](refang(raw));
  return value === null ? null : { value, key: value };
}

/** What a valid `type` looks like, for an error message. */
export const observableExpected = (type: ObservableType) => `${observableTypeLabel[type]} must be ${observableExample[type]}`;

/**
 * An Asset's identifier as it was first written, with whitespace tidied; host names and account names
 * are case-insensitive, so it is keyed in lowercase. Null if empty.
 */
export function normaliseAsset(type: AssetType, raw: string): Normalised | null {
  let value = raw.trim().replace(/\s+/g, " ");
  if (type === "host") value = value.replace(/\.$/, "");
  return value ? { value, key: value.toLowerCase() } : null;
}

/**
 * An Observable as it is safe to show and copy: domains, URLs and email addresses defanged so they
 * can't be clicked or resolved by accident (`invoice-portal[.]biz`, `hxxps://…`).
 */
export function defang(type: ObservableType, value: string) {
  switch (type) {
    case "domain":
    case "email":
      return value.replaceAll(".", "[.]");
    case "url":
      return value.replace(/^http/i, "hxxp").replace(/^ftp/i, "fxp").replaceAll(".", "[.]");
    default:
      return value;
  }
}
