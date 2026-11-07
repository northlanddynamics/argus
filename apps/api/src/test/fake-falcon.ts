import type {
  AlertPatch,
  FalconClient,
  FalconComment,
  FalconConnection,
  FalconConnector,
  FalconHost,
  FalconIoc,
  NewIoc,
  StreamEvent,
  StreamSession,
} from "../crowdstrike/falcon";
import { FalconScopeMissing } from "../crowdstrike/falcon";

/**
 * A fake Falcon for tests: one Event Stream per tenant (keyed by API client id), with consecutive
 * offsets. Tests emit events into it, drop open connections, and make Falcon forget old events
 * (as its replay window does) to create gaps it can no longer replay. Each tenant also has the
 * Alerts API, recording every patch it accepts and serving each Alert's comments, and users to
 * look up by email. A comment in a patch it accepts becomes one of the Alert's comments, as in Falcon.
 * And it has IOC Management: the custom IOCs it holds, every one it was asked to create or delete,
 * and the means to refuse or fail those calls. And the Hosts API: the devices it knows, every read
 * of them, and the means to refuse it for want of Hosts: Read or to fail it.
 */

/** A device as Falcon would report it, with `fields` changed. */
export function fakeHost(deviceId: string, fields: Partial<FalconHost> = {}): FalconHost {
  return {
    deviceId,
    hostname: "FIN-LT-0231",
    platform: "Windows",
    osVersion: "Windows 11",
    sensorVersion: "7.18.18403.0",
    sensorStatus: "Normal",
    firstSeen: "2025-03-02T08:15:00.000Z",
    lastSeen: "2026-01-01T08:55:00.000Z",
    localIp: "10.20.4.31",
    externalIp: "203.0.113.24",
    macAddress: "3c-52-82-1a-9b-04",
    domain: "ACME",
    ou: ["Finance", "Laptops"],
    site: "Leeds",
    serialNumber: "PF3XK2LM",
    manufacturer: "LENOVO",
    model: "ThinkPad T14 Gen 4",
    lastLoggedOnUser: "ACME\\d.howe",
    hostGroups: ["Finance laptops"],
    tags: ["FalconGroupingTags/finance"],
    containment: "normal",
    ...fields,
  };
}

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

    /** Every patch the Alerts API accepted, in order. */
    patches: [] as { compositeIds: string[]; patch: AlertPatch }[],
    /** The tenant's Falcon users: login email → UUID. */
    users: new Map<string, string>(),
    /** Set to make every Alerts API call and user lookup fail with this message. */
    refuseWrites: null as string | null,
    /** How many more Alerts API calls fail before they succeed again. */
    failNextWrites: 0,

    /** Each Alert's comments, by composite ID, oldest first. */
    comments: new Map<string, FalconComment[]>(),
    /** The composite ID of every Alert whose comments were read, in order. */
    commentReads: [] as string[],
    /** Set to make reading comments fail with this message. */
    refuseReads: null as string | null,

    /** The custom IOCs it holds, by id. */
    iocs: new Map<string, FalconIoc>(),
    /** Every IOC it created, in order. */
    iocsCreated: [] as NewIoc[],
    /** The id of every IOC it deleted, in order. */
    iocsDeleted: [] as string[],
    /** Set to make every IOC Management call fail with this message, as when the API client lacks the scope. */
    refuseIocs: null as string | null,
    /** How many more IOC Management calls fail before they succeed again. */
    failNextIocCalls: 0,

    /** The devices the Hosts API knows, by `aid`. */
    hosts: new Map<string, FalconHost>(),
    /** The `aid`s of every read of the Hosts API, in order. */
    hostReads: [] as string[][],
    /** Set to make every Hosts API read fail for want of Hosts: Read, with this message. */
    refuseHosts: null as string | null,
    /** How many more Hosts API reads fail before they succeed again. */
    failNextHostReads: 0,

    /** Adds a custom IOC, as someone would in the console; returns its id. */
    holdIoc(ioc: Omit<FalconIoc, "id">) {
      const id = crypto.randomUUID();
      tenant.iocs.set(id, { ...ioc, id });
      return id;
    },

    /** Adds a comment to an Alert, as a Falcon user would in the console; returns it. */
    comment(
      compositeId: string,
      body: string,
      { author = "jsmith@acme.example", at = null, id = crypto.randomUUID() }: { author?: string; at?: Date | null; id?: string } = {},
    ) {
      const comment: FalconComment = { id, author, body, createdAt: at };
      tenant.comments.set(compositeId, [...(tenant.comments.get(compositeId) ?? []), comment]);
      return comment;
    },

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
    /** Fails as the tenant is set to. */
    const iocCall = () => {
      if (t.refuseIocs) throw new Error(t.refuseIocs);
      if (t.failNextIocCalls > 0) {
        t.failNextIocCalls--;
        throw new Error("Calling IOC Management in Falcon failed: 503");
      }
    };
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
      async updateAlerts(compositeIds, patch) {
        if (t.refuseWrites) throw new Error(t.refuseWrites);
        if (t.failNextWrites > 0) {
          t.failNextWrites--;
          throw new Error("Updating Alerts in Falcon failed: 503");
        }
        t.patches.push({ compositeIds: [...compositeIds], patch });
        if (patch.comment !== undefined) {
          for (const id of compositeIds) t.comment(id, patch.comment, { author: "argus-api-client" });
        }
      },
      async findUser(email) {
        if (t.refuseWrites) throw new Error(t.refuseWrites);
        return t.users.get(email.toLowerCase()) ?? null;
      },
      async alertComments(compositeId) {
        if (t.refuseReads) throw new Error(t.refuseReads);
        t.commentReads.push(compositeId);
        return [...(t.comments.get(compositeId) ?? [])];
      },
      async findIoc(type, value) {
        iocCall();
        return [...t.iocs.values()].find((i) => i.type === type && i.value === value) ?? null;
      },
      async createIoc(ioc) {
        iocCall();
        if ([...t.iocs.values()].some((i) => i.type === ioc.type && i.value === ioc.value)) {
          throw new Error("Creating a custom IOC in Falcon failed: 409 Duplicate type: value combination");
        }
        t.iocsCreated.push(ioc);
        const id = crypto.randomUUID();
        t.iocs.set(id, { ...ioc, id });
        return id;
      },
      async deleteIoc(id) {
        iocCall();
        // Already gone: Falcon says so, and nothing is deleted.
        if (!t.iocs.delete(id)) return false;
        t.iocsDeleted.push(id);
        return true;
      },
      async hosts(deviceIds) {
        if (t.refuseHosts) throw new FalconScopeMissing(t.refuseHosts);
        if (t.failNextHostReads > 0) {
          t.failNextHostReads--;
          throw new Error("Reading hosts from Falcon failed: 503");
        }
        t.hostReads.push([...deviceIds]);
        return deviceIds.flatMap((id) => {
          const host = t.hosts.get(id);
          return host ? [{ ...host }] : [];
        });
      },
    };
  };

  return { connect, tenant };
}
