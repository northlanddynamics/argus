/**
 * Finding the Observables in free text, for Bulk Lookup (GLOSSARY.md): an email, a threat report,
 * a list. Plain functions on strings, shared with the SPA, so no runtime-specific APIs.
 *
 * Each value is read with the same normalisers as one typed in (`vocabulary.ts`), after the text is
 * refanged, and each distinct Observable is found once, in the order it first appears. A URL's or
 * an email address's host is found as a domain too, and IPs and hashes inside URLs are found.
 *
 * A domain (including an email address's) counts only when it ends in a public suffix and is more
 * than that suffix (`public-suffixes.ts`), and never when its last part is a common file extension,
 * so `report.pdf`, `setup.sh` and `notes.zip` aren't domains.
 */
import { PUBLIC_SUFFIX_RULES } from "./public-suffixes";
import { normaliseObservable, type ObservableType } from "./vocabulary";

/** The most text Bulk Lookup reads at once, in bytes of UTF-8: about 100 KB. */
export const BULK_LOOKUP_MAX_BYTES = 100_000;
/** The most distinct Observables Bulk Lookup returns at once. */
export const BULK_LOOKUP_MAX_VALUES = 1_000;

export type Extracted = { type: ObservableType; value: string };
export type Extraction = { ok: true; observables: Extracted[] } | { ok: false; reason: string };

/** File extensions that are never read as a domain's last part, though some are top-level domains. */
const FILE_EXTENSIONS = new Set(
  (
    "7z apk asp aspx bak bat bin bmp cab cfg cmd conf cpl csv dat db deb dll dmg doc docm docx dot dotx " +
    "drv eml exe gif gz hta htm html ico img ini iso jar jpeg jpg js json jsp lnk log md mov mp3 mp4 msg msi " +
    "odp ods odt one ocx pdf php pl png pps ppt pptm pptx ps1 psd py rar rb reg rpm rtf scr sh so svg sys tar tgz " +
    "tif tiff tmp ts txt vbe vbs wav webp wsf xls xlsb xlsm xlsx xml xz yaml yml zip"
  ).split(" "),
);

const SUFFIXES = new Set(PUBLIC_SUFFIX_RULES.split(" "));

/**
 * How many of `labels` (a normalised domain's, left to right) are its public suffix, by the Public
 * Suffix List's rules; null when no rule covers it (the list's "*" default is not used).
 */
function publicSuffixLength(labels: string[]) {
  for (let i = 0; i < labels.length; i++) {
    const name = labels.slice(i).join(".");
    if (SUFFIXES.has(`!${name}`)) return labels.length - i - 1;
    const parent = labels.slice(i + 1).join(".");
    if (SUFFIXES.has(name) || (parent && SUFFIXES.has(`*.${parent}`))) return labels.length - i;
  }
  return null;
}

/** Whether a normalised domain is one: under a public suffix, and not a file name. */
export function isRegistrableDomain(domain: string) {
  const labels = domain.split(".");
  if (FILE_EXTENSIONS.has(labels.at(-1)!)) return false;
  const suffix = publicSuffixLength(labels);
  return suffix !== null && labels.length > suffix;
}

/** Undoes the usual defanging anywhere in the text, not only at the start of a value. */
const refangText = (text: string) =>
  text
    .replace(/\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\)/gi, ".")
    .replace(/\[@\]|\(@\)|\[at\]|\(at\)/gi, "@")
    .replace(/\[:\/\/\]/g, "://")
    .replace(/\[:\]/g, ":")
    .replace(/\bhxxp(s?)(?=:\/\/)/gi, "http$1")
    .replace(/\bfxp(?=:\/\/)/gi, "ftp");

/** A URL without the punctuation that ends the sentence around it, keeping balanced brackets. */
function trimUrl(url: string) {
  let s = url;
  for (;;) {
    const last = s.at(-1) ?? "";
    const open = { ")": "(", "]": "[", "}": "{" }[last];
    if (open && s.split(open).length > s.split(last).length - 1) break;
    if (!/[.,;:!?'")\]}>*]/.test(last)) break;
    s = s.slice(0, -1);
  }
  return s;
}

const letterOrDigit = String.raw`\p{L}\p{N}`;
const label = String.raw`[${letterOrDigit}](?:[${letterOrDigit}-]{0,61}[${letterOrDigit}])?`;

/** What each type looks like in running text; each match is then checked by its normaliser. */
const patterns: { type: ObservableType | "hash"; pattern: RegExp; tidy?: (s: string) => string }[] = [
  { type: "url", pattern: /\b(?:https?|ftp):\/\/[^\s<>"'`]+/giu, tidy: trimUrl },
  { type: "email", pattern: new RegExp(String.raw`[${letterOrDigit}._%+'-]+@[${letterOrDigit}.-]+`, "gu"), tidy: (s) => s.replace(/[.-]+$/, "") },
  { type: "ip", pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g },
  { type: "ip", pattern: /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:]|\.\w)/gi },
  { type: "hash", pattern: new RegExp(String.raw`(?<![${letterOrDigit}_])[0-9a-f]{32,64}(?![${letterOrDigit}_])`, "giu") },
  {
    type: "domain",
    pattern: new RegExp(
      String.raw`(?<![${letterOrDigit}_.-])(?:${label}\.)+[\p{L}][${letterOrDigit}-]{0,62}(?![${letterOrDigit}_@-]|\.[${letterOrDigit}])`,
      "gu",
    ),
  },
];

const HASH_TYPES: Record<number, ObservableType> = { 32: "md5", 40: "sha1", 64: "sha256" };

/** Whether a found value counts, beyond being valid for its type. */
function counts(type: ObservableType, value: string) {
  if (type === "domain") return isRegistrableDomain(value);
  if (type === "email") return isRegistrableDomain(value.slice(value.lastIndexOf("@") + 1));
  // `::` and the like are valid, but never what someone meant.
  if (type === "ip" && value.includes(":")) return value.split(":").filter(Boolean).length >= 2;
  return true;
}

/**
 * Every distinct Observable in `text`, normalised, in the order each first appears; or why the text
 * is refused: it is over `BULK_LOOKUP_MAX_BYTES`, or holds more than `BULK_LOOKUP_MAX_VALUES`.
 */
export function extractObservables(text: string): Extraction {
  if (new TextEncoder().encode(text).length > BULK_LOOKUP_MAX_BYTES) {
    return { ok: false, reason: "The text is over 100 KB. Split it and look up each part." };
  }
  const plain = refangText(text);
  const found: { at: number; type: ObservableType; value: string }[] = [];
  for (const { type, pattern, tidy } of patterns) {
    for (const match of plain.matchAll(pattern)) {
      const raw = tidy ? tidy(match[0]) : match[0];
      const as = type === "hash" ? HASH_TYPES[raw.length] : type;
      if (!as) continue;
      const normalised = normaliseObservable(as, raw);
      if (normalised && counts(as, normalised.value)) found.push({ at: match.index, type: as, value: normalised.value });
    }
  }
  const seen = new Set<string>();
  const observables: Extracted[] = [];
  for (const { type, value } of found.toSorted((x, y) => x.at - y.at)) {
    const key = `${type} ${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    observables.push({ type, value });
  }
  if (observables.length > BULK_LOOKUP_MAX_VALUES) {
    return {
      ok: false,
      reason: `The text holds ${observables.length.toLocaleString("en")} values, more than the ${BULK_LOOKUP_MAX_VALUES.toLocaleString("en")} Bulk Lookup takes at once. Split it and look up each part.`,
    };
  }
  return { ok: true, observables };
}
