import { sql } from "drizzle-orm";
import type postgres from "postgres";
import type { CaseAccessFacts } from "../access/policy";
import type { Db, Tx } from "../db/client";

/**
 * Change signals between processes (ADR 0005), over Postgres LISTEN/NOTIFY. Every `web` instance
 * listens and forwards what its own sockets may see; anything that changes data publishes.
 *
 * Signals carry ids, never content, and stay far below NOTIFY's 8000-byte payload limit.
 */

const CHANNEL = "argus_signals";

export type Signal =
  /**
   * A Case changed. `before` is who could see it before the change, when that changed too,
   * so people who just lost sight of it still hear about it (and drop it from their screens).
   * It names only the facts that changed.
   * `membersOnly`: only Internal items changed, so Guests on the Case don't hear about it.
   */
  | {
      kind: "case";
      organizationId: string;
      caseId: string;
      before?: Partial<Pick<CaseAccessFacts, "restricted" | "assigneeId" | "caseRoleHolderIds" | "guests">>;
      membersOnly?: boolean;
    }
  /** Who is viewing a Case changed. */
  | { kind: "presence"; organizationId: string; caseId: string }
  /** Membership changed (removed, role changed, Organization deleted): who sees what may have too. */
  | { kind: "members"; organizationId: string }
  /** The Organization's Alerts or Integrations changed. */
  | { kind: "alerts"; organizationId: string };

/**
 * Publishes `signal`. Inside a transaction it is delivered only if and when that transaction
 * commits, so call it in the same transaction as the change it announces.
 */
export async function publish(db: Db | Tx, signal: Signal) {
  await db.execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify(signal)})`);
}

/** Where a process hears signals from every process. */
export type SignalSource = {
  /**
   * Calls `onSignal` for every signal, in commit order. `onResume` runs when listening resumes
   * after the connection dropped, since signals sent meanwhile were lost.
   */
  listen(onSignal: (signal: Signal) => void, onResume: () => void): Promise<{ stop: () => Promise<void> }>;
};

/** Listens on a dedicated connection from `client`'s pool. */
export function postgresSignals(client: postgres.Sql): SignalSource {
  return {
    async listen(onSignal, onResume) {
      let listened = false;
      const { unlisten } = await client.listen(
        CHANNEL,
        (payload) => onSignal(JSON.parse(payload) as Signal),
        () => {
          if (listened) onResume();
          listened = true;
        },
      );
      return { stop: unlisten };
    },
  };
}
