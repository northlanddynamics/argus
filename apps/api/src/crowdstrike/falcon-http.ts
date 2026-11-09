import type { FalconCloud } from "../alerts/vocabulary";
import { createHash } from "node:crypto";
import type { Severity } from "../cases/vocabulary";
import type { FalconIocAction, FalconIocType } from "../response-actions/vocabulary";
import {
  type AlertPatch,
  FALCON_CONTAINMENT,
  type FalconClient,
  type FalconComment,
  type FalconConnection,
  type FalconContainment,
  type FalconHost,
  type FalconIdentity,
  type FalconIoc,
  FalconScopeMissing,
  type NewIoc,
  type StreamEvent,
  type StreamSession,
} from "./falcon";

/**
 * The Falcon API over HTTP: OAuth2 client credentials, then the Event Streams discovery, refresh and
 * data feed endpoints, the Alerts update and read endpoints, the user lookup, the IOC Management
 * endpoints, the Hosts API (read by `aid`, and searched by hostname) and Identity Protection's
 * GraphQL API (identities read by entity ID, and searched by account name). Unverified against a live tenant (see spec #1, "Further Notes").
 */

const BASE_URLS: Record<FalconCloud, string> = {
  "us-1": "https://api.crowdstrike.com",
  "us-2": "https://api.us-2.crowdstrike.com",
  "eu-1": "https://api.eu-1.crowdstrike.com",
  "us-gov-1": "https://api.laggar.gcw.crowdstrike.com",
};

/** Falcon's default when a session says nothing: 30 minutes. */
const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60_000;

/** How long a write or lookup may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;

/** `patch` as Falcon's `action_parameters`. */
export function actionParameters(patch: AlertPatch) {
  const params: { name: string; value: string }[] = [];
  if (patch.status !== undefined) params.push({ name: "update_status", value: patch.status });
  if (patch.assignTo !== undefined) params.push(patch.assignTo === null ? { name: "unassign", value: "" } : { name: "assign_to_uuid", value: patch.assignTo });
  if (patch.comment !== undefined) params.push({ name: "append_comment", value: patch.comment });
  return params;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Falcon's timestamps: ISO strings, or seconds or milliseconds since the epoch. */
function when(v: unknown) {
  if (typeof v === "string" && v.trim() && Number.isNaN(Number(v))) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n > 1e12 ? n : n * 1000);
}

/**
 * The comments in an Alert entity as Falcon returns it, oldest first. Comments without an id of
 * their own are given one derived from their time, author and text, so the same comment is
 * recognised on every fetch.
 */
export function readComments(alert: Record<string, unknown> | undefined): FalconComment[] {
  const list = alert?.comments;
  if (!Array.isArray(list)) return [];
  const comments: FalconComment[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const body = text(c.value) ?? text(c.comment) ?? text(c.text) ?? text(c.body);
    if (!body) continue;
    const author = text(c.user_name) ?? text(c.created_by) ?? text(c.user_id) ?? text(c.user_uuid);
    const createdAt = when(c.timestamp ?? c.created_timestamp ?? c.created_on);
    const id =
      text(c.id) ??
      text(c.comment_id) ??
      `sha256:${createHash("sha256").update(JSON.stringify([createdAt?.toISOString() ?? null, author, body])).digest("hex")}`;
    comments.push({ id, author, body, createdAt });
  }
  return comments.toSorted((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
}

/** A quoted FQL string: a quote or backslash in it is escaped. */
const fqlString = (s: string) => `'${s.replace(/[\\']/g, (c) => `\\${c}`)}'`;

/** `ioc` as Falcon's IOC Management API takes it. */
export const iocBody = (ioc: NewIoc) => ({
  type: ioc.type,
  value: ioc.value,
  action: ioc.action,
  severity: ioc.severity,
  platforms: [...ioc.platforms],
  applied_globally: ioc.appliedGlobally,
  source: ioc.source,
  description: ioc.description,
});

/** An IOC as Falcon returns it. */
export function readIoc(r: Record<string, unknown>): FalconIoc | null {
  if (typeof r.id !== "string" || typeof r.type !== "string" || typeof r.value !== "string") return null;
  return {
    id: r.id,
    type: r.type as FalconIocType,
    value: r.value,
    action: (typeof r.action === "string" ? r.action : "detect") as FalconIocAction,
    severity: (typeof r.severity === "string" ? r.severity.toLowerCase() : "medium") as Severity,
    platforms: Array.isArray(r.platforms) ? r.platforms.filter((p): p is string => typeof p === "string") : [],
    appliedGlobally: true,
    source: typeof r.source === "string" ? r.source : "",
    description: typeof r.description === "string" ? r.description : "",
  };
}

/** The most devices the Hosts API returns in one call. */
const HOSTS_PER_CALL = 100;

const texts = (v: unknown) => (Array.isArray(v) ? v.map(text).filter((t): t is string => t !== null) : []);

const isoTime = (v: unknown) => when(v)?.toISOString() ?? null;

/** The sensor's state, from its reduced functionality mode and provisioning status. */
function sensorStatus(r: Record<string, unknown>) {
  const rfm = text(r.reduced_functionality_mode)?.toLowerCase();
  if (rfm === "yes") return "Reduced functionality mode";
  const provisioned = text(r.provision_status);
  if (provisioned && provisioned.toLowerCase() !== "provisioned") return provisioned;
  return rfm === "no" || provisioned ? "Normal" : null;
}

/** A device as the Hosts API returns it, its host groups named by `groupNames` where known. */
export function readHost(r: Record<string, unknown>, groupNames: ReadonlyMap<string, string> = new Map()): FalconHost | null {
  const deviceId = text(r.device_id)?.toLowerCase();
  if (!deviceId) return null;
  const status = text(r.status)?.toLowerCase();
  return {
    deviceId,
    hostname: text(r.hostname),
    platform: text(r.platform_name),
    osVersion: text(r.os_version) ?? text(r.os_product_name),
    sensorVersion: text(r.agent_version),
    sensorStatus: sensorStatus(r),
    firstSeen: isoTime(r.first_seen),
    lastSeen: isoTime(r.last_seen),
    localIp: text(r.local_ip),
    externalIp: text(r.external_ip),
    macAddress: text(r.mac_address),
    domain: text(r.machine_domain),
    ou: texts(r.ou),
    site: text(r.site_name),
    serialNumber: text(r.serial_number),
    manufacturer: text(r.system_manufacturer),
    model: text(r.system_product_name),
    lastLoggedOnUser: text(r.last_login_user),
    hostGroups: texts(r.groups).map((id) => groupNames.get(id) ?? id),
    tags: texts(r.tags),
    containment: status && (FALCON_CONTAINMENT as readonly string[]).includes(status) ? (status as FalconContainment) : null,
  };
}

/** The most identities read in one Identity Protection query. */
const IDENTITIES_PER_CALL = 100;

const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const records = (v: unknown) => (Array.isArray(v) ? v.map(record).filter((r): r is Record<string, unknown> => r !== null) : []);
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);

/** What Identity Protection's GraphQL API is asked about each identity (`readIdentity` reads it). */
const IDENTITY_FIELDS = `
  entityId primaryDisplayName secondaryDisplayName type riskScore riskScoreSeverity watched
  riskFactors { type severity }
  roles { type }
  ... on UserEntity {
    emailAddresses mostRecentActivity
    accounts {
      ... on ActiveDirectoryAccountDescriptor {
        domain samAccountName upn ou department title enabled lockoutTime
        passwordAttributes { lastChange mayExpire }
      }
    }
  }
  associations {
    ... on EntityAssociation { bindingType entity { type primaryDisplayName } }
  }
`;

/** Risk factors that say an account is stale, or its password never expires. */
const STALE = new Set(["STALE_ACCOUNT", "INACTIVE_ACCOUNT"]);
const NEVER_EXPIRES = "PASSWORD_NEVER_EXPIRES";

/** A user identity as Identity Protection's GraphQL API returns it. */
export function readIdentity(node: Record<string, unknown>): FalconIdentity | null {
  const entityId = text(node.entityId);
  if (!entityId) return null;
  const account = records(node.accounts)[0] ?? {};
  const password = record(account.passwordAttributes) ?? {};
  const riskFactors = records(node.riskFactors).flatMap((f) => {
    const type = text(f.type);
    return type ? [{ type, severity: text(f.severity) }] : [];
  });
  const factor = (types: (t: string) => boolean) => riskFactors.some((f) => types(f.type.toUpperCase()));
  const roles = records(node.roles);
  const associated = records(node.associations).flatMap((a) => {
    const entity = record(a.entity);
    const name = text(entity?.primaryDisplayName);
    return entity && name ? [{ type: text(entity.type)?.toUpperCase() ?? null, name }] : [];
  });
  const score = typeof node.riskScore === "number" && Number.isFinite(node.riskScore) ? node.riskScore : null;
  const lockout = account.lockoutTime;
  const mayExpire = bool(password.mayExpire);
  return {
    entityId,
    displayName: text(node.primaryDisplayName),
    upn: text(account.upn),
    samAccountName: text(account.samAccountName),
    riskScore: score,
    riskSeverity: text(node.riskScoreSeverity),
    riskFactors,
    enabled: bool(account.enabled),
    lockedOut: typeof lockout === "boolean" ? lockout : lockout === undefined ? null : when(lockout) !== null,
    stale: "riskFactors" in node ? factor((t) => STALE.has(t)) : null,
    privileged: roles.length > 0 || factor((t) => t.includes("PRIVILEGED")) ? true : "roles" in node ? false : null,
    privilegedGroups: [...new Set(associated.filter((a) => a.type === "GROUP").map((a) => a.name))],
    watched: bool(node.watched),
    passwordLastSet: isoTime(password.lastChange),
    passwordNeverExpires: mayExpire !== null ? !mayExpire : factor((t) => t === NEVER_EXPIRES) || null,
    lastActivity: isoTime(node.mostRecentActivity),
    email: texts(node.emailAddresses)[0] ?? null,
    department: text(account.department),
    title: text(account.title),
    domain: text(account.domain),
    ou: text(account.ou),
    endpoints: [...new Set(associated.filter((a) => a.type === "ENDPOINT").map((a) => a.name))],
  };
}

/** Whether identity `i` goes by `domain`: its DNS name, or that name's first label (the NetBIOS name, usually). */
export const inDomain = (i: { domain: string | null }, domain: string) => {
  const d = i.domain?.toLowerCase();
  const wanted = domain.toLowerCase();
  return d === wanted || d?.split(".")[0] === wanted;
};

/** A Falcon API call failed; the message says which and how. */
export class FalconError extends Error {}

async function failure(what: string, res: Response) {
  let detail = "";
  try {
    const body = (await res.json()) as { errors?: { message?: string }[] };
    detail = body.errors?.map((e) => e.message).filter(Boolean).join("; ") ?? "";
  } catch {
    // Not JSON: the status says enough.
  }
  return new FalconError(`${what} failed: ${res.status}${detail ? ` ${detail}` : ""}`);
}

export function falconHttpClient({ cloud, credentials, appId }: FalconConnection, fetchImpl: typeof fetch = fetch): FalconClient {
  const base = BASE_URLS[cloud];
  let token: { value: string; expiresAt: number } | null = null;

  const accessToken = async () => {
    if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
    const res = await fetchImpl(`${base}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret }),
    });
    if (!res.ok) throw await failure("Signing in to the Falcon API", res);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return token.value;
  };

  /** The user identities Identity Protection returns for `filter`, which uses `$values`. */
  const identityQuery = async (what: string, filter: string, values: readonly string[]) => {
    const query = `query ($values: [String!]) { entities(types: [USER], ${filter}) { nodes { ${IDENTITY_FIELDS} } } }`;
    const res = await fetchImpl(`${base}/identity-protection/combined/graphql/v1`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query, variables: { values } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Without the scope, or without an Identity Protection subscription, Falcon refuses with 403.
    if (res.status === 403) throw new FalconScopeMissing((await failure(what, res)).message);
    if (!res.ok) throw await failure(what, res);
    const body = (await res.json()) as { data?: { entities?: { nodes?: unknown } } | null; errors?: { message?: string }[] | null };
    if (body.errors?.length) throw new FalconError(`${what} failed: ${body.errors.map((e) => e.message).filter(Boolean).join("; ")}`);
    return records(body.data?.entities?.nodes);
  };

  /** Takes device action `action` (contain, or lift containment) on device `deviceId`; needs Hosts: Write. */
  const deviceAction = async (action: "contain" | "lift_containment", deviceId: string, what: string) => {
    const res = await fetchImpl(`${base}/devices/entities/devices-actions/v2?${new URLSearchParams({ action_name: action })}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ids: [deviceId] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 403) throw new FalconScopeMissing(`${what} failed: the API client lacks the Hosts: Write scope`);
    if (!res.ok) throw await failure(what, res);
  };

  return {
    async openStream() {
      const url = `${base}/sensors/entities/datafeed/v2?${new URLSearchParams({ appId, format: "json" })}`;
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" } });
      if (!res.ok) throw await failure("Opening the Event Stream", res);
      const body = (await res.json()) as {
        resources?: {
          dataFeedURL: string;
          sessionToken: { token: string };
          refreshActiveSessionURL: string;
          refreshActiveSessionInterval?: number;
        }[];
      };
      const stream = body.resources?.[0];
      if (!stream) throw new FalconError("Falcon offered no Event Stream: is Event Streams enabled for this subscription?");
      return {
        dataFeedUrl: stream.dataFeedURL,
        token: stream.sessionToken.token,
        refreshUrl: stream.refreshActiveSessionURL,
        refreshIntervalMs: stream.refreshActiveSessionInterval ? stream.refreshActiveSessionInterval * 1000 : DEFAULT_REFRESH_INTERVAL_MS,
      } satisfies StreamSession;
    },

    async refreshStream(session) {
      const res = await fetchImpl(session.refreshUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ action_name: "refresh_active_stream_session", appId }),
      });
      if (!res.ok) throw await failure("Refreshing the Event Stream session", res);
    },

    async updateAlerts(compositeIds, patch) {
      const res = await fetchImpl(`${base}/alerts/entities/alerts/v3`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ composite_ids: compositeIds, action_parameters: actionParameters(patch) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw await failure("Updating Alerts in Falcon", res);
    },

    async findUser(email) {
      const filter = `uid:${fqlString(email)}`;
      const res = await fetchImpl(`${base}/user-management/queries/users/v1?${new URLSearchParams({ filter })}`, {
        headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw await failure("Looking up a Falcon user", res);
      const body = (await res.json()) as { resources?: string[] };
      return body.resources?.[0] ?? null;
    },

    async alertComments(compositeId) {
      const res = await fetchImpl(`${base}/alerts/entities/alerts/v2`, {
        method: "POST",
        headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ composite_ids: [compositeId] }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw await failure("Reading an Alert's comments from Falcon", res);
      const body = (await res.json()) as { resources?: Record<string, unknown>[] };
      return readComments(body.resources?.[0]);
    },

    async findIoc(type, value) {
      const filter = `type:${fqlString(type)}+value:${fqlString(value)}`;
      const res = await fetchImpl(`${base}/iocs/combined/indicator/v1?${new URLSearchParams({ filter, limit: "1" })}`, {
        headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw await failure("Looking up a custom IOC in Falcon", res);
      const body = (await res.json()) as { resources?: Record<string, unknown>[] };
      const found = body.resources?.[0];
      return found ? readIoc(found) : null;
    },

    async createIoc(ioc) {
      const res = await fetchImpl(`${base}/iocs/entities/indicators/v1`, {
        method: "POST",
        headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ indicators: [iocBody(ioc)] }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw await failure("Creating a custom IOC in Falcon", res);
      const body = (await res.json()) as { resources?: Record<string, unknown>[]; errors?: { message?: string }[] | null };
      const id = body.resources?.[0]?.id;
      if (typeof id !== "string") {
        const detail = body.errors?.map((e) => e.message).filter(Boolean).join("; ");
        throw new FalconError(`Creating a custom IOC in Falcon failed${detail ? `: ${detail}` : ": Falcon returned no IOC"}`);
      }
      return id;
    },

    async deleteIoc(id) {
      const res = await fetchImpl(`${base}/iocs/entities/indicators/v1?${new URLSearchParams({ ids: id })}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 404) return false;
      if (!res.ok) throw await failure("Deleting a custom IOC in Falcon", res);
      return true;
    },

    async hosts(deviceIds) {
      const found: Record<string, unknown>[] = [];
      for (let i = 0; i < deviceIds.length; i += HOSTS_PER_CALL) {
        const res = await fetchImpl(`${base}/devices/entities/devices/v2`, {
          method: "POST",
          headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ ids: deviceIds.slice(i, i + HOSTS_PER_CALL) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status === 403) throw new FalconScopeMissing((await failure("Reading hosts from Falcon", res)).message);
        // Falcon answers 404 when some of the devices are unknown, with the ones it knows.
        if (!res.ok && res.status !== 404) throw await failure("Reading hosts from Falcon", res);
        const body = (await res.json().catch(() => ({}))) as { resources?: Record<string, unknown>[] | null };
        found.push(...(body.resources ?? []));
      }
      // Host group names need Host groups: Read; without it the groups are shown by id.
      const groupIds = [...new Set(found.flatMap((r) => texts(r.groups)))];
      const groupNames = new Map<string, string>();
      if (groupIds.length) {
        try {
          const res = await fetchImpl(`${base}/devices/entities/host-groups/v1?${new URLSearchParams(groupIds.map((id): [string, string] => ["ids", id]))}`, {
            headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (res.ok) {
            const body = (await res.json()) as { resources?: { id?: unknown; name?: unknown }[] | null };
            for (const g of body.resources ?? []) {
              const id = text(g.id);
              const name = text(g.name);
              if (id && name) groupNames.set(id, name);
            }
          }
        } catch {
          // The ids will do.
        }
      }
      return found.map((r) => readHost(r, groupNames)).filter((h): h is FalconHost => h !== null);
    },

    async findHosts(hostname) {
      const found = new Set<string>();
      for (let offset = 0; ; ) {
        const query = new URLSearchParams({ filter: `hostname:${fqlString(hostname)}`, limit: String(HOSTS_PER_CALL), offset: String(offset) });
        const res = await fetchImpl(`${base}/devices/queries/devices/v1?${query}`, {
          headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status === 403) throw new FalconScopeMissing((await failure("Finding hosts in Falcon", res)).message);
        if (!res.ok) throw await failure("Finding hosts in Falcon", res);
        const body = (await res.json()) as { resources?: unknown[] | null; meta?: { pagination?: { total?: unknown } } };
        const ids = texts(body.resources);
        for (const id of ids) found.add(id.toLowerCase());
        offset += ids.length;
        const total = body.meta?.pagination?.total;
        if (!ids.length || typeof total !== "number" || offset >= total) break;
      }
      return [...found];
    },

    async containHost(deviceId) {
      await deviceAction("contain", deviceId, "Containing a host in Falcon");
    },

    async liftContainment(deviceId) {
      await deviceAction("lift_containment", deviceId, "Lifting containment in Falcon");
    },

    async identities(entityIds) {
      const found: FalconIdentity[] = [];
      for (let i = 0; i < entityIds.length; i += IDENTITIES_PER_CALL) {
        const ids = entityIds.slice(i, i + IDENTITIES_PER_CALL);
        const nodes = await identityQuery("Reading identities from Falcon", `entityIds: $values, first: ${ids.length}`, ids);
        found.push(...nodes.map(readIdentity).filter((n): n is FalconIdentity => n !== null));
      }
      return found;
    },

    async findIdentities(name) {
      const what = "Finding identities in Falcon";
      if ("upn" in name) {
        const byUpn = await identityQuery(what, `userPrincipalNames: $values, first: ${IDENTITIES_PER_CALL}`, [name.upn]);
        const byEmail = await identityQuery(what, `emailAddresses: $values, first: ${IDENTITIES_PER_CALL}`, [name.upn]);
        return [...new Set([...byUpn, ...byEmail].map((n) => text(n.entityId)).filter((id): id is string => id !== null))];
      }
      const nodes = (await identityQuery(what, `samAccountNames: $values, first: ${IDENTITIES_PER_CALL}`, [name.samAccountName]))
        .map(readIdentity)
        .filter((n): n is FalconIdentity => n !== null);
      return nodes.filter((n) => !("domain" in name) || inDomain(n, name.domain)).map((n) => n.entityId);
    },

    async *consume(session, offset, signal) {
      const url = new URL(session.dataFeedUrl);
      url.searchParams.set("offset", String(offset));
      const res = await fetchImpl(url, { headers: { authorization: `Token ${session.token}`, accept: "application/json" }, signal });
      if (!res.ok || !res.body) throw await failure("Reading the Event Stream", res);
      // Newline-delimited JSON; blank lines are keep-alives.
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of res.body) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) yield parseEvent(line);
        }
      }
    },
  };
}

function parseEvent(line: string): StreamEvent {
  const parsed = JSON.parse(line) as {
    metadata: { offset: number; eventType: string; eventCreationTime?: number };
    event?: Record<string, unknown>;
  };
  const { offset, eventType, eventCreationTime } = parsed.metadata;
  return { offset, eventType, createdAt: eventCreationTime ? new Date(eventCreationTime) : null, event: parsed.event ?? {} };
}
