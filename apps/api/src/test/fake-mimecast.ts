import type { BlockedSender, MimecastClient, MimecastConnector, MimecastCredentials, NewBlockedSender } from "../mimecast/mimecast";
import { MimecastRefused } from "../mimecast/mimecast";

/**
 * A fake Mimecast for tests: one account per API application (keyed by client id), holding its
 * Blocked Senders policy entries. It records every entry it was asked to create or delete, and can
 * refuse the credentials or fail calls.
 */

export type FakeMimecastAccount = ReturnType<typeof fakeAccount>;

function fakeAccount() {
  const account = {
    /** Every credentials check, with the credentials it was made with. */
    checks: [] as MimecastCredentials[],
    /** Set to refuse the credentials with this message, as Mimecast does bad or revoked ones. */
    refuse: null as string | null,
    /** Set to make every call fail with this message, as when Mimecast can't be reached. */
    unreachable: null as string | null,
    /** The Blocked Senders entries it holds, by id. */
    blocked: new Map<string, BlockedSender>(),
    /** Every entry it created, in order. */
    created: [] as NewBlockedSender[],
    /** The id of every entry it deleted, in order. */
    deleted: [] as string[],
    /** How many more Blocked Senders calls fail before they succeed again. */
    failNextCalls: 0,

    /** Adds a Blocked Senders entry, as an administrator would in the console; returns its id. */
    hold(entry: Omit<BlockedSender, "id">) {
      const id = crypto.randomUUID();
      account.blocked.set(id, { ...entry, id });
      return id;
    },
  };
  return account;
}

export function fakeMimecast() {
  const accounts = new Map<string, FakeMimecastAccount>();
  const account = (clientId: string) => {
    let found = accounts.get(clientId);
    if (!found) accounts.set(clientId, (found = fakeAccount()));
    return found;
  };

  const connect: MimecastConnector = (credentials) => {
    const a = account(credentials.clientId);
    const signIn = () => {
      if (a.unreachable) throw new Error(a.unreachable);
      if (a.refuse) throw new MimecastRefused(a.refuse);
    };
    const policyCall = () => {
      signIn();
      if (a.failNextCalls > 0) {
        a.failNextCalls--;
        throw new Error("Mimecast is unavailable (503)");
      }
    };
    const client: MimecastClient = {
      async check() {
        a.checks.push(credentials);
        signIn();
      },
      async findBlockedSender(type, value) {
        policyCall();
        return [...a.blocked.values()].find((b) => b.type === type && b.value === value) ?? null;
      },
      async blockSender(entry) {
        policyCall();
        a.created.push(entry);
        return a.hold(entry);
      },
      async deleteBlockedSender(id) {
        policyCall();
        if (!a.blocked.delete(id)) return false;
        a.deleted.push(id);
        return true;
      },
    };
    return client;
  };

  return { account, connect };
}

export type FakeMimecast = ReturnType<typeof fakeMimecast>;
