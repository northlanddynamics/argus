import type { Deps } from "../deps";
import type { FalconClient, FalconConnector, StreamSession } from "./falcon";
import { processStreamEvent, reportHealth, reportReleased, reportSessionRefresh, streamConnection, streamTargets } from "./stream-state";

/**
 * The `worker` process's job (ADR 0001, 0002): hold the Event Streams connection of every Integration
 * it can claim, and turn their events into Alerts.
 *
 * Each Integration's stream is owned by exactly one worker at a time: whoever holds its Postgres
 * advisory lock. Locks are taken on one connection reserved for the purpose, so they are released
 * when the worker lets go, or when it dies and its connection closes; another worker then claims
 * the stream on its next tick and resumes from the stored offset.
 *
 * `tick` does the housekeeping and is run every `STREAM_TICK_MS`: claim unowned Integrations,
 * let go of paused ones, reconnect dropped streams or ones whose credentials were rotated, and
 * refresh stream sessions before Falcon expires them.
 */

export const STREAM_TICK_MS = 5_000;
/** How long before a stream session would expire it is refreshed. */
export const SESSION_REFRESH_MARGIN_MS = 5 * 60_000;
/** The first half of an advisory lock key, naming Argus's Integration stream locks. */
const LOCK_NAMESPACE = 0x41524753;

type Stream = {
  credentialsRevision: number;
  client: FalconClient;
  session: StreamSession;
  /** When the session is to be refreshed next, by the worker's clock (ms). */
  refreshAt: number;
  abort: AbortController;
  /** The read loop; settles once the stream has ended or been stopped. */
  reading: Promise<void>;
  /** The stream ended or failed by itself; reconnect on the next tick. */
  ended: boolean;
};

/** How long after (re)opening or refreshing a session to refresh it again. */
const sessionRefreshDelay = (session: StreamSession) =>
  Math.max(session.refreshIntervalMs - SESSION_REFRESH_MARGIN_MS, session.refreshIntervalMs / 2);

type LockConnection = Awaited<ReturnType<Deps["db"]["$client"]["reserve"]>>;

export function createStreamWorker(
  { db, clock, credentials }: Pick<Deps, "db" | "clock" | "credentials">,
  { connect, workerId }: { connect: FalconConnector; workerId: string },
) {
  /** Integrations whose lock this worker holds, with their stream while it is open. */
  const held = new Map<string, Stream | null>();
  let locks: LockConnection | null = null;
  let closed = false;

  const report = (id: string, health: Parameters<typeof reportHealth>[3]) =>
    reportHealth(db, clock, id, health).catch((e: unknown) => console.error("worker: reporting health:", e));

  const lockConnection = async () => {
    if (locks) {
      try {
        await locks`select 1`;
        return locks;
      } catch {
        // The connection is gone, and every lock with it: other workers may own those streams now.
        locks = null;
        for (const stream of held.values()) if (stream) await stop(stream);
        held.clear();
      }
    }
    locks = await db.$client.reserve();
    return locks;
  };

  const tryLock = async (id: string) => {
    const conn = await lockConnection();
    const [row] = await conn<{ locked: boolean }[]>`select pg_try_advisory_lock(${LOCK_NAMESPACE}, hashtext(${id})) as locked`;
    return row?.locked === true;
  };

  const unlock = async (id: string) => {
    if (!locks) return;
    await locks`select pg_advisory_unlock(${LOCK_NAMESPACE}, hashtext(${id}))`;
  };

  /** Stops reading `stream`, and waits until it has. */
  const stop = async (stream: Stream) => {
    stream.abort.abort();
    await stream.reading;
  };

  /** Connects the Integration's stream and starts reading from the stored offset; null if it couldn't. */
  const start = async (id: string): Promise<Stream | null> => {
    const found = await streamConnection(db, credentials, id);
    if (!found) return null;
    let client: FalconClient;
    let session: StreamSession;
    try {
      client = connect(found.connection);
      session = await client.openStream();
    } catch (e) {
      await report(id, { health: "error", detail: e instanceof Error ? e.message : String(e), workerId });
      return null;
    }
    const refreshAt = clock.now().getTime() + sessionRefreshDelay(session);
    await report(id, { health: "connected", workerId, sessionRefreshAt: new Date(refreshAt) });

    const abort = new AbortController();
    const stream: Stream = {
      credentialsRevision: found.credentialsRevision,
      client,
      session,
      refreshAt,
      abort,
      reading: Promise.resolve(),
      ended: false,
    };
    stream.reading = (async () => {
      let detail = "The stream closed; reconnecting from the stored offset";
      try {
        for await (const event of client.consume(session, found.resumeFrom, abort.signal)) {
          if (abort.signal.aborted) return;
          await processStreamEvent(db, clock, id, event);
        }
      } catch (e) {
        detail = `The stream failed (${e instanceof Error ? e.message : String(e)}); reconnecting from the stored offset`;
      }
      if (abort.signal.aborted) return;
      stream.ended = true;
      await report(id, { health: "disconnected", detail, workerId });
    })();
    return stream;
  };

  const refresh = async (id: string, stream: Stream) => {
    try {
      await stream.client.refreshStream(stream.session);
    } catch (e) {
      await stop(stream);
      held.set(id, null);
      await report(id, { health: "error", detail: `Refreshing the stream session failed: ${e instanceof Error ? e.message : String(e)}`, workerId });
      return;
    }
    stream.refreshAt = clock.now().getTime() + sessionRefreshDelay(stream.session);
    await reportSessionRefresh(db, id, new Date(stream.refreshAt));
  };

  const housekeeping = async () => {
    if (closed) return;
    const targets = new Map((await streamTargets(db)).map((t) => [t.id, t]));
    await lockConnection();

    for (const [id, stream] of held) {
      const target = targets.get(id);
      if (!target || target.paused) {
        if (stream) await stop(stream);
        held.delete(id);
        await unlock(id);
        await reportReleased(db, clock, id, workerId);
        continue;
      }
      if (stream && (stream.ended || stream.credentialsRevision !== target.credentialsRevision)) {
        await stop(stream);
        held.set(id, null);
      }
    }

    for (const target of targets.values()) {
      if (target.paused || held.has(target.id)) continue;
      if (await tryLock(target.id)) held.set(target.id, null);
    }

    for (const [id, stream] of held) {
      if (closed) return;
      if (!stream) {
        held.set(id, await start(id));
        continue;
      }
      if (clock.now().getTime() >= stream.refreshAt) await refresh(id, stream);
    }
  };

  let queue = Promise.resolve();
  /** Runs `work` after everything queued before it, so ticks never overlap. */
  const enqueue = (work: () => Promise<void>) => {
    const next = queue.then(work);
    queue = next.catch((e: unknown) => console.error("worker:", e));
    return next;
  };

  return {
    workerId,
    /** One round of housekeeping; see above. */
    tick: () => enqueue(housekeeping),

    /** Lets go of every stream and lock. */
    close: () =>
      enqueue(async () => {
        closed = true;
        for (const [id, stream] of held) {
          if (stream) await stop(stream);
          await reportReleased(db, clock, id, workerId);
        }
        held.clear();
        if (locks) {
          await locks`select pg_advisory_unlock_all()`.catch(() => {});
          locks.release();
          locks = null;
        }
      }),
  };
}

export type StreamWorker = ReturnType<typeof createStreamWorker>;
