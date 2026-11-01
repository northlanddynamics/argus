import type { FalconClient, FalconConnection, FalconConnector, StreamEvent, StreamSession } from "../crowdstrike/falcon";

/**
 * A fake Falcon for tests: one Event Stream per tenant (keyed by API client id), with consecutive
 * offsets. Tests emit events into it, drop open connections, and make Falcon forget old events
 * (as its replay window does) to create gaps it can no longer replay.
 */

type Consumer = {
  next: number;
  /** Waiting for an event past the last one emitted. */
  waiting: boolean;
  wake: () => void;
  dropped: boolean;
};

export type FakeTenant = ReturnType<typeof fakeTenant>;

function fakeTenant() {
  const events: StreamEvent[] = [];
  let nextOffset = 0;
  /** Events before this offset are no longer held. */
  let earliest = 0;
  const consumers = new Set<Consumer>();
  const wakeAll = () => consumers.forEach((c) => c.wake());

  const tenant = {
    /** Every stream session opened, with the credentials and app id it was opened with. */
    opened: [] as FalconConnection[],
    /** How many times a session was refreshed. */
    refreshes: 0,
    /** The offset each read of the stream started from. */
    readsFrom: [] as number[],
    /** Set to make opening a stream fail, as when Falcon refuses the credentials. */
    refuse: null as string | null,
    /** Set to make refreshing a session fail. */
    refuseRefresh: null as string | null,
    /** Set to make the next read start at this offset whatever was asked for, as a replay would. */
    replayFrom: null as number | null,

    /** Adds an event to the stream; returns its offset. */
    emit(eventType: string, event: Record<string, unknown>, createdAt: Date | null = null) {
      const offset = nextOffset++;
      events.push({ offset, eventType, createdAt, event });
      wakeAll();
      return offset;
    },

    /** Adds a detection event of `eventType` with `CompositeId` and whatever else is given. */
    detection(eventType: string, compositeId: string, fields: Record<string, unknown> = {}) {
      return tenant.emit(eventType, { CompositeId: compositeId, ...fields });
    },

    /** Ends every open read of the stream, as when the connection drops. */
    drop() {
      for (const c of consumers) {
        c.dropped = true;
        c.wake();
      }
    },

    /** Forgets every event up to and including `offset`, as if its replay window had passed. */
    forgetThrough(offset: number) {
      earliest = Math.max(earliest, offset + 1);
    },

    /** How many reads of the stream are open now. */
    get connections() {
      return [...consumers].filter((c) => !c.dropped).length;
    },

    /** Resolves once every open read has processed every event emitted, and is waiting for more. */
    async drained(ms = 3000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const open = [...consumers].filter((c) => !c.dropped);
        if (open.every((c) => c.waiting && c.next >= nextOffset)) {
          // Let the processing of the last event settle before looking again.
          await new Promise((r) => setTimeout(r, 5));
          if ([...consumers].filter((c) => !c.dropped).every((c) => c.waiting && c.next >= nextOffset)) return;
        }
        if (Date.now() > deadline) throw new Error("The fake stream was not drained in time");
        await new Promise((r) => setTimeout(r, 5));
      }
    },

    async *read(from: number, signal: AbortSignal): AsyncGenerator<StreamEvent> {
      tenant.readsFrom.push(from);
      const start = tenant.replayFrom ?? from;
      tenant.replayFrom = null;
      const consumer: Consumer = { next: Math.max(start, earliest), waiting: false, wake: () => {}, dropped: false };
      consumers.add(consumer);
      const onAbort = () => consumer.wake();
      signal.addEventListener("abort", onAbort);
      try {
        for (;;) {
          if (signal.aborted || consumer.dropped) return;
          // Falcon serves from the oldest event it still holds.
          consumer.next = Math.max(consumer.next, earliest);
          const event = events.find((e) => e.offset >= consumer.next);
          if (event) {
            consumer.next = event.offset + 1;
            yield event;
            continue;
          }
          consumer.waiting = true;
          await new Promise<void>((resolve) => (consumer.wake = resolve));
          consumer.waiting = false;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        consumers.delete(consumer);
      }
    },
  };
  return tenant;
}

export function fakeFalcon() {
  const tenants = new Map<string, FakeTenant>();
  /** The tenant whose API client id is `clientId`. */
  const tenant = (clientId: string) => {
    let found = tenants.get(clientId);
    if (!found) tenants.set(clientId, (found = fakeTenant()));
    return found;
  };

  const connect: FalconConnector = (connection): FalconClient => {
    const t = tenant(connection.credentials.clientId);
    return {
      async openStream() {
        if (t.refuse) throw new Error(t.refuse);
        t.opened.push(connection);
        return {
          dataFeedUrl: `https://falcon.test/feed/${connection.appId}`,
          token: crypto.randomUUID(),
          refreshUrl: `https://falcon.test/refresh/${connection.appId}`,
          refreshIntervalMs: 30 * 60_000,
        } satisfies StreamSession;
      },
      async refreshStream() {
        if (t.refuseRefresh) throw new Error(t.refuseRefresh);
        t.refreshes++;
      },
      consume: (_session, offset, signal) => t.read(offset, signal),
    };
  };

  return { connect, tenant };
}
