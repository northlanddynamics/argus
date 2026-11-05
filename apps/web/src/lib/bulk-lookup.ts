import type { ObservableType } from "api/observables/vocabulary";
import { api, errorMessage } from "@/lib/api";

export { BULK_LOOKUP_MAX_VALUES, extractObservables } from "api/observables/extract";

/** Every Observable in `text`, each known (with where it appears) or not. */
export async function bulkLookup(text: string) {
  const res = await api["bulk-lookup"].$post({ json: { text } });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not look the text up"));
  const body = await res.json();
  if (!("observables" in body)) throw new Error("Unexpected response");
  return body.observables;
}

export type LookupResult = Awaited<ReturnType<typeof bulkLookup>>[number];

/** Links `observables` to Case `number` as hand links; how many were linked, and how many already were. */
export async function linkToCase(number: number, observables: { type: ObservableType; value: string }[]) {
  const res = await api["bulk-lookup"].link.$post({ json: { case: number, observables } });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not link them"));
  const body = await res.json();
  if (!("linked" in body)) throw new Error("Unexpected response");
  return body;
}
