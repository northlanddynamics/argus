import {
  type Destination,
  type DestinationList,
  DestinationListNotFound,
  findExact,
  type UmbrellaClient,
  type UmbrellaCredentials,
  UmbrellaRefused,
} from "./umbrella";

/**
 * The Cisco Umbrella API v2 over HTTP: OAuth 2.0 client credentials at `/auth/v2/token`, then the
 * Policies API's destination list endpoints (`/policies/v2/destinationlists…`). The API key needs
 * the Policies · Destination Lists read and write scopes. Unverified against a live account.
 */

const BASE_URL = "https://api.umbrella.com";

/** How long a call may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How many lists, or destinations, to read per page. */
const PAGE_SIZE = 100;
/** The most pages read of one listing. */
const MAX_PAGES = 500;

/** Umbrella keeps a destination's comment short. */
export const MAX_COMMENT_LENGTH = 255;

/** An Umbrella API call failed; the message says which and how. */
export class UmbrellaError extends Error {}

type Envelope<T> = { status?: { code?: number; text?: string }; meta?: { page?: number; limit?: number; total?: number }; data?: T };

async function failure(what: string, res: Response) {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string; error?: string; error_description?: string; status?: { text?: string } };
    detail = body.error_description ?? body.message ?? body.status?.text ?? body.error ?? "";
  } catch {
    // Not JSON: the status says enough.
  }
  return `${what} failed: ${res.status}${detail ? ` ${detail}` : ""}`;
}

/** A destination list as the API returns it. */
export function readDestinationList(r: Record<string, unknown>): DestinationList | null {
  if (typeof r.id !== "number" || typeof r.name !== "string") return null;
  if (r.access !== "allow" && r.access !== "block") return null;
  const meta = r.meta as { destinationCount?: unknown } | undefined;
  return {
    id: r.id,
    name: r.name,
    access: r.access,
    isGlobal: r.isGlobal === true,
    destinationCount: typeof meta?.destinationCount === "number" ? meta.destinationCount : null,
  };
}

/** A destination as the API returns it. */
export function readDestination(r: Record<string, unknown>): Destination | null {
  if ((typeof r.id !== "string" && typeof r.id !== "number") || typeof r.destination !== "string") return null;
  return {
    id: String(r.id),
    destination: r.destination,
    type: typeof r.type === "string" ? r.type : "domain",
    comment: typeof r.comment === "string" && r.comment ? r.comment : null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : typeof r.createdAt === "number" ? new Date(r.createdAt * 1000).toISOString() : null,
  };
}

export function umbrellaHttpClient(credentials: UmbrellaCredentials, fetchImpl: typeof fetch = fetch): UmbrellaClient {
  let token: { value: string; expiresAt: number } | null = null;

  const accessToken = async () => {
    if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
    const res = await fetchImpl(`${BASE_URL}/auth/v2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new UmbrellaRefused(await failure("Signing in to the Umbrella API", res));
    if (!res.ok) throw new UmbrellaError(await failure("Signing in to the Umbrella API", res));
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return token.value;
  };

  /** Calls `path`; resolves to Umbrella's envelope, null on a 404, or rejects with what went wrong. */
  const call = async <T>(what: string, method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        accept: "application/json",
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new UmbrellaRefused(await failure(what, res));
    if (!res.ok) throw new UmbrellaError(await failure(what, res));
    return (await res.json()) as Envelope<T>;
  };

  /** Every item of a paged listing at `path`; null when Umbrella has nothing there. */
  const all = async (what: string, path: string) => {
    const items: Record<string, unknown>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await call<Record<string, unknown>[]>(what, "GET", `${path}?page=${page}&limit=${PAGE_SIZE}`);
      if (!body) return page === 1 ? null : items;
      const data = body.data ?? [];
      items.push(...data);
      const total = body.meta?.total;
      if (data.length < PAGE_SIZE || (typeof total === "number" && items.length >= total)) return items;
    }
    return items;
  };

  const destinations = async (listId: number) => {
    const rows = await all("Reading an Umbrella destination list", `/policies/v2/destinationlists/${listId}/destinations`);
    if (!rows) throw new DestinationListNotFound(listId);
    return rows.map(readDestination).filter((d): d is Destination => d !== null);
  };

  return {
    async check() {
      token = null;
      await accessToken();
    },

    async destinationLists() {
      const rows = (await all("Listing Umbrella destination lists", "/policies/v2/destinationlists")) ?? [];
      return rows.map(readDestinationList).filter((l): l is DestinationList => l !== null);
    },

    destinations,

    async addDestination(listId, entry) {
      const body = await call("Adding a destination to Umbrella", "POST", `/policies/v2/destinationlists/${listId}/destinations`, [
        { destination: entry.destination, comment: entry.comment.slice(0, MAX_COMMENT_LENGTH) },
      ]);
      if (!body) throw new DestinationListNotFound(listId);
      // Umbrella answers with the list, not the destination: read it back for its id.
      const added = findExact(await destinations(listId), entry.destination.toLowerCase());
      if (!added) throw new UmbrellaError("Adding a destination to Umbrella failed: Umbrella doesn't list it afterwards");
      return added.id;
    },

    async removeDestination(listId, id) {
      const held = await destinations(listId).catch((e: unknown) => {
        if (e instanceof DestinationListNotFound) return null;
        throw e;
      });
      if (!held?.some((d) => d.id === id)) return false;
      const numeric = Number(id);
      const body = await call("Removing a destination from Umbrella", "DELETE", `/policies/v2/destinationlists/${listId}/destinations/remove`, [
        Number.isSafeInteger(numeric) ? numeric : id,
      ]);
      return body !== null;
    },
  };
}
