import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** Under the Case's key, so its live signal refreshes it. */
export const evidenceKey = (number: number) => ["cases", number, "evidence"] as const;

export const evidenceQuery = (number: number) =>
  queryOptions({
    queryKey: evidenceKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"].evidence.$get({ param: { number: String(number) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the Evidence");
      return (await res.json()).evidence;
    },
  });

export type EvidenceView = NonNullable<Awaited<ReturnType<ReturnType<typeof evidenceQuery>["queryFn"] & {}>>>[number];

/**
 * Where Evidence is viewed or downloaded. Both go through the API, which records the access in the
 * Audit Log before sending the file; there is no other URL for it.
 */
export const evidenceUrl = (number: number, id: string, access: "view" | "download") =>
  api.cases[":number"].evidence[":id"][access].$url({ param: { number: String(number), id } }).toString();

/** "84 KB", "2.1 MB", "16 GB". */
export function formatBytes(bytes: number) {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "3b9e…a01f": enough of a fingerprint to tell files apart at a glance. */
export const shortHash = (sha256: string) => `${sha256.slice(0, 4)}…${sha256.slice(-4)}`;

/**
 * Uploads `file` as Evidence, `internal` to hide it from Guests. The file is the request body, so a
 * multi-gigabyte memory image streams straight through; `onProgress` gets the fraction sent so far.
 * Resolves with the Evidence as added.
 */
export function uploadEvidence(number: number, file: File, internal: boolean, onProgress: (fraction: number) => void) {
  const url = api.cases[":number"].evidence.$url({
    param: { number: String(number) },
    query: { name: file.name, ...(internal && { internal: "true" as const }) },
  });
  return new Promise<EvidenceView>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url.toString());
    xhr.responseType = "json";
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener("load", () => {
      const body = xhr.response as { evidence?: EvidenceView; error?: unknown } | null;
      if (xhr.status === 201 && body?.evidence) resolve(body.evidence);
      else reject(new Error(typeof body?.error === "string" ? body.error : `Could not add ${file.name}`));
    });
    xhr.addEventListener("error", () => reject(new Error(`Could not add ${file.name}: the upload was interrupted`)));
    xhr.send(file);
  });
}
