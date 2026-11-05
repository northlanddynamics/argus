import { queryOptions } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";
import type { ObservableType } from "api/observables/vocabulary";
import type { FalconIocAction } from "api/response-actions/vocabulary";

export {
  FALCON_IOC_ACTIONS,
  type FalconIocAction,
  falconAllowsPrevent,
  falconIocActionLabel,
  falconIocType,
  responseActionKindLabel,
  responseActionStateLabel,
} from "api/response-actions/vocabulary";

/** Under the Case's key, so its live signal refreshes them. */
export const responseActionsKey = (number: number) => ["cases", number, "response-actions"] as const;

/** The Case's Response Actions, and the Integrations a Member can send to: null when the Case isn't found. */
export const responseActionsQuery = (number: number) =>
  queryOptions({
    queryKey: responseActionsKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"]["response-actions"].$get({ param: { number: String(number) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the Response Actions");
      const body = await res.json();
      if (!("responseActions" in body)) throw new Error("Unexpected response");
      return body;
    },
  });

export type ResponseActionsOnCase = NonNullable<Awaited<ReturnType<ReturnType<typeof responseActionsQuery>["queryFn"] & {}>>>;
export type ResponseAction = ResponseActionsOnCase["responseActions"][number];

/** An Observable on the Ignored list that a send has to confirm. */
export type IgnoredInSend = { id: string; type: ObservableType; value: string };
/** An Observable a Provider doesn't take, left out of a send, and why. */
export type SkippedInSend = { observable: IgnoredInSend; provider: string; reason: string };

/**
 * Sends each of Observables `observableIds` on Case `number` to each of Integrations
 * `integrationIds` as a Falcon custom IOC. Without `confirmIgnored`, a send that includes Ignored
 * Observables is refused, and they come back in `ignored` to confirm.
 */
export async function takeResponseActions(
  number: number,
  input: { observableIds: string[]; integrationIds: string[]; action: FalconIocAction; internal: boolean; confirmIgnored: boolean },
): Promise<{ ignored: IgnoredInSend[] } | { taken: number; skipped: SkippedInSend[] }> {
  const res = await api.cases[":number"]["response-actions"].bulk.$post({ param: { number: String(number) }, json: input });
  if (res.status === 409) {
    const body = (await res.json()) as { error?: string; ignored?: IgnoredInSend[] };
    if (body.ignored) return { ignored: body.ignored };
    throw new Error(body.error ?? "Could not take the Response Actions");
  }
  if (!res.ok) throw new Error(await errorMessage(res, "Could not take the Response Actions"));
  const body = await res.json();
  if (!("skipped" in body)) throw new Error("Unexpected response");
  return { taken: body.responseActions.length, skipped: body.skipped };
}

/** Dismisses an "already present" record from Case `number`, leaving the tool alone. */
export async function dismissResponseAction(number: number, id: string) {
  const res = await api.cases[":number"]["response-actions"][":id"].dismiss.$post({ param: { number: String(number), id } });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not dismiss the Response Action"));
}

/** Tries a Failed Response Action again. */
export async function retryResponseAction(number: number, id: string) {
  const res = await api.cases[":number"]["response-actions"][":id"].retry.$post({ param: { number: String(number), id } });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not retry the Response Action"));
}
