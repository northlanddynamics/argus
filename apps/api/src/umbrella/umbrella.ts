/**
 * Cisco Umbrella as Argus uses it (ADR 0014): an adapter, so Argus runs against the real Umbrella API
 * v2 (`umbrella-http.ts`) in production and a fake in tests (`test/fake-umbrella.ts`).
 *
 * An Umbrella Integration sends no Alerts and writes nothing back. Its credentials are checked for
 * its health (`health.ts`). Its destination lists are read to say which of them hold a domain
 * (`domain-checks.ts`), and a domain is added to, and removed from, the one destination list an Admin
 * chose for it, as a Response Action (`response-actions/sender.ts`), only while its Response Actions
 * setting is on.
 */

/** An Umbrella API key and its secret, used as OAuth 2.0 client credentials. */
export type UmbrellaCredentials = { clientId: string; clientSecret: string };

/** What Umbrella does with what a destination list holds. */
export const DESTINATION_LIST_ACCESS = ["allow", "block"] as const;
export type DestinationListAccess = (typeof DESTINATION_LIST_ACCESS)[number];
export const destinationListAccessLabel: Record<DestinationListAccess, string> = { allow: "Allow", block: "Block" };

/** A destination list as Umbrella describes it. */
export type DestinationList = {
  id: number;
  name: string;
  access: DestinationListAccess;
  /** One of the Organization's two global lists, applied by every policy. */
  isGlobal: boolean;
  /** How many destinations it holds, when Umbrella says. */
  destinationCount: number | null;
};

/** One destination a list holds: a domain, a URL or an IP address. */
export type Destination = {
  /** Umbrella's id for the destination within its list. */
  id: string;
  destination: string;
  type: string;
  comment: string | null;
  createdAt: string | null;
};

/** A destination as Argus adds it: a domain, with a comment naming the Case. */
export type NewDestination = { destination: string; comment: string };

/** Umbrella refused the credentials: they are wrong, revoked, or the key lacks the scope. */
export class UmbrellaRefused extends Error {}

/** Umbrella holds no destination list with that id. */
export class DestinationListNotFound extends Error {
  constructor(id: number) {
    super(`Umbrella has no destination list ${id}`);
  }
}

export interface UmbrellaClient {
  /** Resolves when Umbrella accepts the credentials; rejects with `UmbrellaRefused` when it refuses them, or another error when it can't be reached. */
  check(): Promise<void>;
  /** Every destination list of the Organization in Umbrella. */
  destinationLists(): Promise<DestinationList[]>;
  /** Every destination list `listId` holds. Rejects with `DestinationListNotFound` when there is no such list. */
  destinations(listId: number): Promise<Destination[]>;
  /** Adds `entry` to list `listId`; resolves to Umbrella's id for it. Rejects when Umbrella refuses or fails. */
  addDestination(listId: number, entry: NewDestination): Promise<string>;
  /**
   * Removes destination `id` from list `listId`. Resolves to true when Umbrella removed it, false when
   * the list no longer holds it, or no longer exists (it is already gone). Rejects when Umbrella refuses or fails.
   */
  removeDestination(listId: number, id: string): Promise<boolean>;
}

/** Makes the client for one Integration. */
export type UmbrellaConnector = (credentials: UmbrellaCredentials) => UmbrellaClient;

/** A destination as Umbrella compares domains: lower case, without a leading `*.` or a trailing dot. */
const bareDomain = (value: string) => value.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");

/**
 * Whether destination `d` covers `domain` (lower case): a domain destination covers itself and every
 * name under it, as Umbrella applies it. URLs and IP addresses never cover a domain.
 */
export function covers(d: Pick<Destination, "destination" | "type">, domain: string): "exact" | "parent" | null {
  if (d.type !== "domain") return null;
  const entry = bareDomain(d.destination);
  if (!entry) return null;
  if (entry === domain) return "exact";
  return domain.endsWith(`.${entry}`) ? "parent" : null;
}

/** The destination in `destinations` that is exactly `domain`, as Argus adds it, if there is one. */
export const findExact = (destinations: readonly Destination[], domain: string) => destinations.find((d) => covers(d, domain) === "exact") ?? null;
