import { createApiClient } from "api/client";
import { createAuthClient } from "better-auth/react";
import { adminClient, organizationClient } from "better-auth/client/plugins";
import { queryOptions } from "@tanstack/react-query";

export const api = createApiClient(window.location.origin).api;

export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  plugins: [adminClient(), organizationClient()],
});

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async () => {
    const res = await api.me.$get();
    if (res.status === 401) return null;
    if (!res.ok) throw new Error("Could not load your account");
    return res.json();
  },
});

export type Me = NonNullable<Awaited<ReturnType<typeof meQuery.queryFn & {}>>>;

/** Reads `{ error }` from a failed API response. */
export async function errorMessage(res: Response, fallback: string) {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}
