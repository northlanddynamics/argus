import { passkeyClient } from "@better-auth/passkey/client";
import { createApiClient } from "api/client";
import { createAuthClient } from "better-auth/react";
import { adminClient, magicLinkClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { queryOptions, useQuery } from "@tanstack/react-query";

export const api = createApiClient(window.location.origin).api;

export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  plugins: [adminClient(), organizationClient(), twoFactorClient(), passkeyClient(), magicLinkClient()],
});

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async () => {
    const res = await api.me.$get();
    // 403: signed in with a password but TOTP enrollment isn't done, so sign in again to finish it.
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error("Could not load your account");
    return res.json();
  },
});

export type Me = NonNullable<Awaited<ReturnType<typeof meQuery.queryFn & {}>>>;

/**
 * The signed-in person as the query cache has them now. Route guards load `me` into the route
 * context, which a layout that stays mounted across navigations doesn't see refreshed.
 */
export const useMe = (loaded: Me): Me => useQuery(meQuery).data ?? loaded;

/** Reads `{ error }` from a failed API response. */
export async function errorMessage(res: Response, fallback: string) {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}
