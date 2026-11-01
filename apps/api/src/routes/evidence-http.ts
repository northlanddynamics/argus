import type { EvidenceView } from "../evidence/evidence";

/**
 * How Evidence travels over HTTP. Evidence is often hostile (a phishing page, a malware sample), and
 * it is served from Argus's own origin, so a browser must never run it: views are sandboxed, never
 * sniffed, and anything that could run is shown as plain text instead.
 */

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** The media type from a request's Content-Type, without parameters; `application/octet-stream` when absent or malformed. */
export function mediaType(header: string | undefined) {
  const type = (header ?? "").split(";")[0]!.trim().toLowerCase();
  return MEDIA_TYPE.test(type) ? type : "application/octet-stream";
}

/** Types a browser shows without running anything. SVG is an image that can carry script, so it isn't one. */
const SHOWN_AS_IS = /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain)$/;

/** `filename` for a Content-Disposition header: an ASCII fallback and the exact UTF-8 name. */
function disposition(kind: "inline" | "attachment", name: string) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Headers for viewing Evidence in the browser. */
export function viewHeaders(e: EvidenceView): Record<string, string> {
  const shown = SHOWN_AS_IS.test(e.contentType) ? e.contentType : "text/plain; charset=utf-8";
  return {
    "content-type": shown,
    "content-length": String(e.size),
    "content-disposition": disposition("inline", e.name),
    "x-content-type-options": "nosniff",
    // An opaque origin with scripts off. Chrome won't show a PDF in a sandbox, and its viewer runs nothing of the file's.
    ...(shown === "application/pdf" ? {} : { "content-security-policy": "sandbox" }),
    // Every view must reach the server, to be recorded.
    "cache-control": "private, no-store",
  };
}

/** Headers for downloading Evidence as a file. */
export function downloadHeaders(e: EvidenceView): Record<string, string> {
  return {
    "content-type": "application/octet-stream",
    "content-length": String(e.size),
    "content-disposition": disposition("attachment", e.name),
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
    "cache-control": "private, no-store",
  };
}
