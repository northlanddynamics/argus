import type {
  AccountName,
  AlertPatch,
  FalconClient,
  FalconComment,
  FalconConnection,
  FalconConnector,
  FalconHost,
  FalconIdentity,
  FalconIoc,
  FalconWorkflow,
  FalconWorkflowExecution,
  NewIoc,
  StreamEvent,
  StreamSession,
} from "../crowdstrike/falcon";
import { FalconScopeMissing, HOSTS_BY_LOCAL_IP_LIMIT } from "../crowdstrike/falcon";
import type { WorkflowInputValues } from "../workflows/vocabulary";

/**
 * A fake Falcon for tests: one Event Stream per tenant (keyed by API client id), with consecutive
 * offsets. Tests emit events into it, drop open connections, and make Falcon forget old events
 * (as its replay window does) to create gaps it can no longer replay. Each tenant also has the
 * Alerts API, recording every patch it accepts and serving each Alert's comments, and users to
 * look up by email. A comment in a patch it accepts becomes one of the Alert's comments, as in Falcon.
 * And it has IOC Management: the custom IOCs it holds, every one it was asked to create or delete,
 * and the means to refuse or fail those calls. And the Hosts API: the devices it knows, every read
 * of them and every search of them by hostname, and the means to refuse it for want of Hosts: Read
 * or to fail it, and containing a device or lifting its containment, with the means to refuse those
 * for want of Hosts: Write or to fail them. And Identity Protection: the identities it knows, every read of them and every
 * search of them by account name, and the means to refuse it (no scope or subscription) or fail it.
 * And Falcon Fusion SOAR: the workflow definitions it holds, every execution it was asked for and
 * how each stands (which tests move along with `finish`), and the means to refuse listing or running
 * them for want of Workflow: Read or Write, or to fail those calls.
 */

/** An on-demand workflow definition as Falcon would list it, with `fields` changed. */
export function fakeWorkflow(id: string, fields: Partial<FalconWorkflow> = {}): FalconWorkflow {
  return {
    id,
    name: "Isolate and notify",
    description: "Contains the host and posts to the SOC channel",
    enabled: true,
    onDemand: true,
    inputs: [
      { name: "hostname", label: "Hostname", type: "string", required: true, description: "The host to act on", options: null },
      { name: "notify", label: "Notify", type: "boolean", required: false, description: null, options: null },
    ],
    ...fields,
  };
}

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

/** A user identity as Identity Protection would report it, with `fields` changed. */
export function fakeIdentity(entityId: string, fields: Partial<FalconIdentity> = {}): FalconIdentity {
  return {
    entityId,
    displayName: "Dana Howe",
    upn: "d.howe@acme.example",
    samAccountName: "d.howe",
    riskScore: 0.62,
    riskSeverity: "MEDIUM",
    riskFactors: [{ type: "WEAK_PASSWORD_POLICY", severity: "MEDIUM" }],
    enabled: true,
    lockedOut: false,
    stale: false,
    privileged: true,
    privilegedGroups: ["Domain Admins"],
    watched: false,
    passwordLastSet: "2025-11-02T09:00:00.000Z",
    passwordNeverExpires: false,
    lastActivity: "2026-01-01T08:55:00.000Z",
    email: "dana.howe@acme.example",
    department: "Finance",
    title: "Controller",
    domain: "ACME.LOCAL",
    ou: "ACME.LOCAL/Finance/Users",
    endpoints: ["FIN-LT-0231"],
    ...fields,
  };
}

const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();

/** Whether `identity` goes by `name`, as Identity Protection matches account names: whatever their case. */
function goesBy(identity: FalconIdentity, name: AccountName) {
  if ("upn" in name) return same(identity.upn, name.upn) || same(identity.email, name.upn);
  if (!same(identity.samAccountName, name.samAccountName)) return false;
  return !("domain" in name) || same(identity.domain, name.domain) || same(identity.domain?.split(".")[0] ?? null, name.domain);
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
    /** Every hostname the Hosts API was searched for, in order. */
    hostSearches: [] as string[],
    /** Every local IP the Hosts API was searched for, in order. */
    ipSearches: [] as string[],

    /** The `aid` of every device it was asked to contain, in order. */
    containments: [] as string[],
    /** Set to make every containment fail for want of Hosts: Write, with this message. */
    refuseContainment: null as string | null,
    /** How many more containment calls fail before they succeed again. */
    failNextContainments: 0,
    /** The `aid` of every device it was asked to lift containment from, in order. */
    lifts: [] as string[],
    /** Set to make every lift fail for want of Hosts: Write, with this message. */
    refuseLifts: null as string | null,
    /** How many more lift calls fail before they succeed again. */
    failNextLifts: 0,

    /** The user identities Identity Protection knows, by entity ID. */
    identities: new Map<string, FalconIdentity>(),
    /** The entity IDs of every read of identities, in order. */
    identityReads: [] as string[][],
    /** Every account name identities were searched for, in order. */
    identitySearches: [] as AccountName[],
    /** Set to make every Identity Protection call fail for want of its scope or subscription, with this message. */
    refuseIdentities: null as string | null,
    /** How many more Identity Protection calls fail before they succeed again. */
    failNextIdentityCalls: 0,

    /** The workflow definitions it holds, by id. */
    workflows: new Map<string, FalconWorkflow>(),
    /** How many times its workflows were listed. */
    workflowListings: 0,
    /** Set to make listing workflows fail for want of Workflow: Read, with this message. */
    refuseWorkflowReads: null as string | null,
    /** Set to make running a workflow fail for want of Workflow: Write, with this message. */
    refuseWorkflowRuns: null as string | null,
    /** How many more workflow calls (listing, running, reading executions) fail before they succeed again. */
    failNextWorkflowCalls: 0,
    /** Every execution it was asked for, in order, with how it stands now. */
    executions: [] as (FalconWorkflowExecution & { definitionId: string; inputs: WorkflowInputValues })[],
    /** The ids of every read of executions, in order. */
    executionReads: [] as string[][],

    /** Ends execution `id` (the latest, if not given) as Falcon would report it, with `fields` changed. */
    finish(outcome: "completed" | "failed" | "cancelled", fields: Partial<FalconWorkflowExecution> = {}, id = tenant.executions.at(-1)?.id) {
      const e = tenant.executions.find((x) => x.id === id);
      if (!e) throw new Error(`No execution ${id}`);
      Object.assign(e, { outcome, status: { completed: "Completed", failed: "Failed", cancelled: "Cancelled" }[outcome], endedAt: new Date(), ...fields });
    },

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
    /** Fails as the tenant is set to. */
    const identityCall = (what: string) => {
      if (t.refuseIdentities) throw new FalconScopeMissing(t.refuseIdentities);
      if (t.failNextIdentityCalls > 0) {
        t.failNextIdentityCalls--;
        throw new Error(`${what} failed: 503`);
      }
    };
    /** Fails as the tenant is set to. */
    const workflowCall = (what: string) => {
      if (t.failNextWorkflowCalls > 0) {
        t.failNextWorkflowCalls--;
        throw new Error(`${what} failed: 503`);
      }
    };
    return {
      async workflows() {
        if (t.refuseWorkflowReads) throw new FalconScopeMissing(t.refuseWorkflowReads);
        workflowCall("Listing workflows in Falcon");
        t.workflowListings++;
        return [...t.workflows.values()].map((w) => ({ ...w, inputs: w.inputs.map((i) => ({ ...i })) }));
      },
      async executeWorkflow(definitionId, inputs) {
        if (t.refuseWorkflowRuns) throw new FalconScopeMissing(t.refuseWorkflowRuns);
        workflowCall("Running a workflow in Falcon");
        const w = t.workflows.get(definitionId);
        if (!w) throw new Error("Running a workflow in Falcon failed: 404 definition not found");
        if (!w.onDemand) throw new Error("Running a workflow in Falcon failed: 400 the workflow has no on-demand trigger");
        const id = crypto.randomUUID();
        t.executions.push({
          id,
          definitionId,
          inputs: { ...inputs },
          outcome: "running",
          status: "In progress",
          startedAt: new Date(),
          endedAt: null,
          activities: [{ name: "Contain host", status: "In progress" }],
          output: null,
          error: null,
        });
        return id;
      },
      async workflowExecutions(ids) {
        if (t.refuseWorkflowReads) throw new FalconScopeMissing(t.refuseWorkflowReads);
        workflowCall("Reading workflow executions from Falcon");
        t.executionReads.push([...ids]);
        return t.executions.filter((e) => ids.includes(e.id)).map(({ definitionId: _d, inputs: _i, ...e }) => structuredClone(e));
      },
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
      async findHosts(hostname) {
        if (t.refuseHosts) throw new FalconScopeMissing(t.refuseHosts);
        if (t.failNextHostReads > 0) {
          t.failNextHostReads--;
          throw new Error("Finding hosts in Falcon failed: 503");
        }
        t.hostSearches.push(hostname);
        // Falcon matches hostnames whatever their case.
        return [...t.hosts.values()].filter((h) => h.hostname?.toLowerCase() === hostname.toLowerCase()).map((h) => h.deviceId);
      },
      async findHostsByLocalIp(ip) {
        if (t.refuseHosts) throw new FalconScopeMissing(t.refuseHosts);
        if (t.failNextHostReads > 0) {
          t.failNextHostReads--;
          throw new Error("Finding hosts by IP in Falcon failed: 503");
        }
        t.ipSearches.push(ip);
        const matched = [...t.hosts.values()]
          .filter((h) => h.localIp === ip)
          .toSorted((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))
          .map((h) => h.deviceId);
        return { deviceIds: matched.slice(0, HOSTS_BY_LOCAL_IP_LIMIT), total: matched.length };
      },
      async containHost(deviceId) {
        if (t.refuseContainment) throw new FalconScopeMissing(t.refuseContainment);
        if (t.failNextContainments > 0) {
          t.failNextContainments--;
          throw new Error("Containing a host in Falcon failed: 503");
        }
        const host = t.hosts.get(deviceId);
        if (!host) throw new Error("Containing a host in Falcon failed: 404 device not found");
        t.containments.push(deviceId);
        // Falcon takes a moment: the host is pending until its sensor confirms.
        t.hosts.set(deviceId, { ...host, containment: "containment_pending" });
      },
      async liftContainment(deviceId) {
        if (t.refuseLifts) throw new FalconScopeMissing(t.refuseLifts);
        if (t.failNextLifts > 0) {
          t.failNextLifts--;
          throw new Error("Lifting containment in Falcon failed: 503");
        }
        const host = t.hosts.get(deviceId);
        if (!host) throw new Error("Lifting containment in Falcon failed: 404 device not found");
        t.lifts.push(deviceId);
        t.hosts.set(deviceId, { ...host, containment: "lift_containment_pending" });
      },
      async identities(entityIds) {
        identityCall("Reading identities from Falcon");
        t.identityReads.push([...entityIds]);
        return entityIds.flatMap((id) => {
          const identity = t.identities.get(id);
          return identity ? [{ ...identity }] : [];
        });
      },
      async findIdentities(name) {
        identityCall("Finding identities in Falcon");
        t.identitySearches.push(name);
        return [...t.identities.values()].filter((i) => goesBy(i, name)).map((i) => i.entityId);
      },
    };
  };

  return { connect, tenant };
}
