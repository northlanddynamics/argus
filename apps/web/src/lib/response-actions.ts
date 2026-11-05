import { queryOptions } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";
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

/** Sends Observable `observableId` on Case `number` to an Integration as a Falcon custom IOC. */
export async function takeResponseAction(
  number: number,
  input: { observableId: string; integrationId: string; action: FalconIocAction; internal: boolean },
) {
  const res = await api.cases[":number"]["response-actions"].$post({ param: { number: String(number) }, json: input });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not take the Response Action"));
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
