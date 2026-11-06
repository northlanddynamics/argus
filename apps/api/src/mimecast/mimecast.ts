/**
 * The Mimecast API as Argus uses it (ADR 0007): an adapter, so the worker runs against the real API
 * 2.0 (`mimecast-http.ts`) in production and a fake in tests (`test/fake-mimecast.ts`).
 *
 * A Mimecast Integration sends no Alerts and writes nothing back. Its credentials are checked for
 * its health (`health.ts`), and Blocked Senders policy entries are looked up, created and deleted
 * for Response Actions (`response-actions/sender.ts`), only while its Response Actions setting is on.
 */

/** A Mimecast API 2.0 application's OAuth client credentials. */
export type MimecastCredentials = { clientId: string; clientSecret: string };

/** What a Blocked Senders entry blocks: one email address, or every address at a domain. */
export type BlockedSenderType = "email" | "domain";

/** A Blocked Senders policy entry as Argus creates it: Organization-wide, for everyone's mail. */
export type NewBlockedSender = {
  type: BlockedSenderType;
  /** The address or domain, in lowercase. */
  value: string;
  /** Who it applies to: always the whole Organization. */
  appliesTo: "everyone";
  description: string;
};

/** A Blocked Senders entry Mimecast holds. */
export type BlockedSender = NewBlockedSender & { id: string };

/** Mimecast refused the credentials: they are wrong, revoked, or lack the permission. */
export class MimecastRefused extends Error {}

export interface MimecastClient {
  /** Resolves when Mimecast accepts the credentials; rejects with `MimecastRefused` when it refuses them, or another error when it can't be reached. */
  check(): Promise<void>;
  /** The Organization-wide Blocked Senders entry for this address or domain, or null when Mimecast holds none. */
  findBlockedSender(type: BlockedSenderType, value: string): Promise<BlockedSender | null>;
  /** Creates the entry; resolves to Mimecast's id for it. Rejects when Mimecast refuses or fails. */
  blockSender(entry: NewBlockedSender): Promise<string>;
  /**
   * Deletes the entry with this id. Resolves to true when Mimecast deleted it, false when it holds no
   * such entry (it is already gone). Rejects when Mimecast refuses or fails.
   */
  deleteBlockedSender(id: string): Promise<boolean>;
}

/** Makes the client for one Integration. */
export type MimecastConnector = (credentials: MimecastCredentials) => MimecastClient;
