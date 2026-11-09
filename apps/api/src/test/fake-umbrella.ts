import type { Destination, DestinationList, NewDestination, UmbrellaClient, UmbrellaConnector, UmbrellaCredentials } from "../umbrella/umbrella";
import { DestinationListNotFound, UmbrellaRefused } from "../umbrella/umbrella";

/**
 * A fake Cisco Umbrella for tests: one account per API key (keyed by client id), holding destination
 * lists and what each holds. It records every destination it was asked to add or remove, counts reads
 * of lists, and can refuse the credentials or fail calls.
 */

export type FakeUmbrellaAccount = ReturnType<typeof fakeAccount>;

function fakeAccount() {
  let nextListId = 1000;
  let nextDestinationId = 1;
  const account = {
    /** Every credentials check, with the credentials it was made with. */
    checks: [] as UmbrellaCredentials[],
    /** Set to refuse the credentials with this message, as Umbrella does a bad or revoked key. */
    refuse: null as string | null,
    /** Set to make every call fail with this message, as when Umbrella can't be reached. */
    unreachable: null as string | null,
    /** The destination lists it holds, by id, with their destinations. */
    lists: new Map<number, { list: DestinationList; destinations: Destination[] }>(),
    /** Every destination added, with its list, in order. */
    added: [] as (NewDestination & { listId: number })[],
    /** Every destination removed, by list and id, in order. */
    removed: [] as { listId: number; id: string }[],
    /** How many times a list's destinations were read. */
    reads: 0,
    /** How many more destination list calls fail before they succeed again. */
    failNextCalls: 0,

    /** Creates a destination list, as an administrator would in the dashboard; returns its id. */
    list(name: string, access: DestinationList["access"] = "block", { isGlobal = false } = {}) {
      const id = nextListId++;
      account.lists.set(id, { list: { id, name, access, isGlobal, destinationCount: 0 }, destinations: [] });
      return id;
    },
    /** Adds a destination to list `listId`, as an administrator would; returns its id. */
    hold(listId: number, destination: string, { type = "domain", comment = null }: { type?: string; comment?: string | null } = {}) {
      const found = account.lists.get(listId)!;
      const id = String(nextDestinationId++);
      found.destinations.push({ id, destination, type, comment, createdAt: "2026-01-01T00:00:00.000Z" });
      found.list.destinationCount = found.destinations.length;
      return id;
    },
  };
  return account;
}

export function fakeUmbrella() {
  const accounts = new Map<string, FakeUmbrellaAccount>();
  const account = (clientId: string) => {
    let found = accounts.get(clientId);
    if (!found) accounts.set(clientId, (found = fakeAccount()));
    return found;
  };

  const connect: UmbrellaConnector = (credentials) => {
    const a = account(credentials.clientId);
    const signIn = () => {
      if (a.unreachable) throw new Error(a.unreachable);
      if (a.refuse) throw new UmbrellaRefused(a.refuse);
    };
    const listCall = () => {
      signIn();
      if (a.failNextCalls > 0) {
        a.failNextCalls--;
        throw new Error("Umbrella is unavailable (503)");
      }
    };
    const listOf = (listId: number) => {
      const found = a.lists.get(listId);
      if (!found) throw new DestinationListNotFound(listId);
      return found;
    };
    const client: UmbrellaClient = {
      async check() {
        a.checks.push(credentials);
        signIn();
      },
      async destinationLists() {
        listCall();
        return [...a.lists.values()].map(({ list }) => ({ ...list }));
      },
      async destinations(listId) {
        listCall();
        a.reads++;
        return listOf(listId).destinations.map((d) => ({ ...d }));
      },
      async addDestination(listId, entry) {
        listCall();
        listOf(listId);
        a.added.push({ ...entry, listId });
        return a.hold(listId, entry.destination, { comment: entry.comment });
      },
      async removeDestination(listId, id) {
        listCall();
        const found = a.lists.get(listId);
        const index = found?.destinations.findIndex((d) => d.id === id) ?? -1;
        if (!found || index < 0) return false;
        found.destinations.splice(index, 1);
        found.list.destinationCount = found.destinations.length;
        a.removed.push({ listId, id });
        return true;
      },
    };
    return client;
  };

  return { account, connect };
}

export type FakeUmbrella = ReturnType<typeof fakeUmbrella>;
