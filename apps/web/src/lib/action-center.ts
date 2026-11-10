import { queryOptions } from "@tanstack/react-query";
import type { CenterAction, CenterGroup } from "api/action-center/vocabulary";
import { api, errorMessage } from "@/lib/api";

export {
  centerActionAccepts,
  centerActionGroup,
  centerActionLabel,
  type CenterAction,
  type CenterGroup,
  isCenterLookup,
  isCenterResponseAction,
  logOutcomeLabel,
  logSourceLabel,
  REASON_MAX_LENGTH,
} from "api/action-center/vocabulary";

/** Everything the Action Center shows, refreshed by the live `actions` signal. */
export const actionCenterKey = ["action-center"] as const;

/** Every action, per Integration, and whether each can run now (ADR 0016). */
export const catalogueQuery = queryOptions({
  queryKey: [...actionCenterKey, "catalogue"],
  queryFn: async () => {
    const res = await api["action-center"].$get();
    if (!res.ok) throw new Error("Could not load the Action Center");
    const body = await res.json();
    if (!("actions" in body)) throw new Error("Unexpected response");
    return body.actions;
  },
});

export type CatalogueCard = Awaited<ReturnType<typeof catalogueQuery.queryFn & {}>>[number];

export type LogFilter = { link?: "linked" | "unlinked"; group?: CenterGroup };

/** The newest page of the Action Log, narrowed by `filter`. */
export const actionLogQuery = (filter: LogFilter = {}) =>
  queryOptions({
    queryKey: [...actionCenterKey, "log", filter],
    queryFn: async () => {
      const res = await api["action-log"].$get({ query: { ...filter, limit: "200" } });
      if (!res.ok) throw new Error("Could not load the Action Log");
      const body = await res.json();
      if (!("entries" in body)) throw new Error("Unexpected response");
      return body;
    },
  });

export type LogEntry = Awaited<ReturnType<ReturnType<typeof actionLogQuery>["queryFn"] & {}>>["entries"][number];

export type RunRequest = {
  action: Exclude<CenterAction, "contain" | "lift_containment">;
  text: string;
  integrationIds?: string[];
  caseNumber?: number | null;
  reason?: string | null;
  internal?: boolean;
  confirmIgnored?: boolean;
};

/** Observables on the Ignored list that a Response Action would send, to confirm first. */
export class IgnoredInRun extends Error {
  readonly observables: { id: string; type: string; value: string }[];
  constructor(message: string, observables: { id: string; type: string; value: string }[]) {
    super(message);
    this.observables = observables;
  }
}

/** Runs an action on the values in `text`; throws `IgnoredInRun` when Ignored Observables need confirming. */
export async function runAction(json: RunRequest) {
  const res = await api["action-center"].run.$post({ json });
  if (res.status === 409) {
    const body = (await res.json()) as { error: string; ignored?: { id: string; type: string; value: string }[] };
    if (body.ignored) throw new IgnoredInRun(body.error, body.ignored);
    throw new Error(body.error);
  }
  if (!res.ok) throw new Error(await errorMessage(res, "Could not run that action"));
  const body = await res.json();
  if (!("values" in body)) throw new Error("Unexpected response");
  return body;
}

export type RunResult = Awaited<ReturnType<typeof runAction>>;

/** Links run `id`, which has no Case, to Case `caseNumber`. */
export async function linkRun(id: string, caseNumber: number) {
  const res = await api["action-log"][":id"].link.$post({ param: { id }, json: { caseNumber } });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not link it to that Case"));
}

/** Retries the Failed Response Action of run `id`, which has no Case. */
export async function retryRun(id: string) {
  const res = await api["action-log"][":id"].retry.$post({ param: { id } });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not retry it"));
}

/** Dismisses the "already present" Response Action of run `id`, which has no Case. */
export async function dismissRun(id: string) {
  const res = await api["action-log"][":id"].dismiss.$post({ param: { id } });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not dismiss it"));
}

export type Relying = { cases: { number: number; title: string }[]; otherCases: number };

/** Removes the Response Action of run `id` from its tool; returns the Cases relying on it when that needs confirming. */
export async function removeRun(id: string, confirmRelying: boolean): Promise<Relying | null> {
  const res = await api["action-log"][":id"].remove.$post({ param: { id }, json: { confirmRelying } });
  if (res.status === 409) {
    const body = (await res.json()) as { error: string } & Partial<Relying>;
    if (body.cases) return { cases: body.cases, otherCases: body.otherCases ?? 0 };
    throw new Error(body.error);
  }
  if (!res.ok) throw new Error(await errorMessage(res, "Could not remove it"));
  return null;
}

/** When this browser last opened the Action Log tab, to count what is new since. */
const SEEN_KEY = "argus.action-log.seen";
export function logSeenAt(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}
export function markLogSeen(at: string) {
  try {
    localStorage.setItem(SEEN_KEY, at);
  } catch {
    // Without storage, every row counts as new until the tab is opened.
  }
}
