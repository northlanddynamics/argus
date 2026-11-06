import { queryOptions } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";
import type { ObservableType } from "api/observables/vocabulary";
import { severityLabel, type Severity } from "api/cases/vocabulary";
import type { Provider } from "api/integrations/vocabulary";
import {
  FALCON_IOC_PLATFORMS,
  type FalconIocDefaults,
  falconIocActionLabel,
  falconIocPlatformLabel,
  type ResponseActionAction,
  type ResponseActionKind,
} from "api/response-actions/vocabulary";

export {
  DEFAULT_FALCON_IOC_DEFAULTS,
  FALCON_IOC_ACTIONS,
  FALCON_IOC_PLATFORMS,
  type FalconIocDefaults,
  type FalconIocPlatform,
  falconIocPlatformLabel,
  iocSeverity,
  type FalconIocAction,
  falconAllowsPrevent,
  falconIocActionLabel,
  falconIocType,
  responseActionKindLabel,
  responseActionStateLabel,
  MIMECAST_ACTIONS,
  type MimecastAction,
  mimecastActionLabel,
  mimecastTarget,
  type ResponseActionAction,
  responseActionActionLabel,
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
/** An Integration a Member can send to from the Case, with what it sends an IOC with. */
export type EligibleIntegration = ResponseActionsOnCase["integrations"][number];

/** The tool a Response Action goes to, as the Case names it: "Falcon" or "Mimecast". */
export const toolOf = (kind: ResponseActionKind) => (kind === "mimecast_blocked_sender" ? "Mimecast" : "Falcon");

/** What it does, as a row names it: "Detect", "Prevent", "Block sender" or "Block domain". */
export const actionOf = (r: Pick<ResponseAction, "kind" | "falcon" | "target">) =>
  r.falcon ? falconIocActionLabel[r.falcon.action] : r.kind === "mimecast_blocked_sender" ? (r.target.type === "domain" ? "Block domain" : "Block sender") : "Sent";

/**
 * "Severity High (from the Case) · every platform", as a menu or dialog says what an IOC goes with;
 * for Mimecast, "Organization-wide" and whether it starts Internal.
 */
export function describeDefaults(d: FalconIocDefaults, caseSeverity?: Severity, provider: Provider = "crowdstrike") {
  if (provider === "mimecast") return `Organization-wide${d.internal ? " · Internal" : ""}`;
  const severity =
    d.severity === "case" ? (caseSeverity ? `Severity ${severityLabel[caseSeverity]} (from the Case)` : "Severity from the Case") : `Severity ${severityLabel[d.severity]}`;
  const platforms = d.platforms.length === FALCON_IOC_PLATFORMS.length ? "every platform" : d.platforms.map((p) => falconIocPlatformLabel[p]).join(", ");
  return `${severity} · ${platforms}`;
}

/** An Observable on the Ignored list that a send has to confirm. */
export type IgnoredInSend = { id: string; type: ObservableType; value: string };
/** An Observable a Provider doesn't take, left out of a send, and why. */
export type SkippedInSend = { observable: IgnoredInSend; provider: string; reason: string };

/**
 * Sends each of Observables `observableIds` on Case `number` to each of Integrations
 * `integrationIds`, all of the Provider whose action `action` is: as a Falcon custom IOC, or a
 * Mimecast blocked sender. Without `confirmIgnored`, a send that includes Ignored
 * Observables is refused, and they come back in `ignored` to confirm.
 */
export async function takeResponseActions(
  number: number,
  /** `internal` left out takes each Integration's default. */
  input: { observableIds: string[]; integrationIds: string[]; action: ResponseActionAction; internal?: boolean; confirmIgnored: boolean },
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

/** Other Cases relying on a Response Action to be removed: those the viewer can see, and how many others. */
export type RelyingCases = { cases: { number: number; title: string }[]; otherCases: number };

/**
 * Removes a Response Action Case `number` created, deleting it in the tool. Without
 * `confirmRelying`, a removal other Cases rely on is refused, and they come back in `relying`.
 */
export async function removeResponseAction(number: number, id: string, confirmRelying: boolean): Promise<{ relying: RelyingCases } | { removing: true }> {
  const res = await api.cases[":number"]["response-actions"][":id"].remove.$post({ param: { number: String(number), id }, json: { confirmRelying } });
  if (res.status === 409) {
    const body = (await res.json()) as { error?: string; relyingCases?: RelyingCases["cases"]; otherCases?: number };
    if (body.relyingCases) return { relying: { cases: body.relyingCases, otherCases: body.otherCases ?? 0 } };
    throw new Error(body.error ?? "Could not remove the Response Action");
  }
  if (!res.ok) throw new Error(await errorMessage(res, "Could not remove the Response Action"));
  return { removing: true };
}
