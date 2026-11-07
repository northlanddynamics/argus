import type { FalconCloud } from "../alerts/vocabulary";
import type { Severity } from "../cases/vocabulary";
import type { FalconIocAction, FalconIocType } from "../response-actions/vocabulary";

/**
 * The Falcon API as Argus uses it (ADR 0002): an adapter, so the worker runs against the real API
 * (`falcon-http.ts`) in production and a fake stream in tests (`test/fake-falcon.ts`).
 *
 * Event Streams in; Alert updates and user lookup out, for the write-back outbox
 * (`write-back.ts`), which writes nothing for an Integration whose `writeBack` is off. An Alert's
 * comments are read on demand (`comment-sync.ts`), whatever the write-back setting. Custom IOCs are
 * looked up, created and deleted for Response Actions (`response-actions/sender.ts`, ADR 0007),
 * which an Integration takes only when its Response Actions setting is on. Hosts are read, and
 * found by hostname, for Enrichment (`host-enrichment.ts`, ADR 0009), which needs only the Hosts: Read scope.
 * A host is contained for a containment Response Action (ADR 0009), which an Integration takes only
 * when its Host containment setting is on, and which needs Hosts: Write.
 * Identity Protection identities are read, and found by account name, for identity Enrichment
 * (`identity-enrichment.ts`, ADR 0009), which needs Identity Protection Entities: Read and an
 * Identity Protection subscription.
 */

export type FalconCredentials = { clientId: string; clientSecret: string };

/** What a client is made from: one Integration's cloud, credentials, and the name its stream is read under. */
export type FalconConnection = { cloud: FalconCloud; credentials: FalconCredentials; appId: string };

/** An open Event Streams session. Falcon expires it unless refreshed within `refreshIntervalMs`. */
export type StreamSession = {
  dataFeedUrl: string;
  token: string;
  refreshUrl: string;
  refreshIntervalMs: number;
};

/**
 * One event from the stream. Offsets are consecutive: an event whose offset is more than one past
 * the last one processed means Falcon no longer holds the events in between.
 */
export type StreamEvent = {
  offset: number;
  eventType: string;
  /** When Falcon created the event, if it said. */
  createdAt: Date | null;
  event: Record<string, unknown>;
};

/**
 * One change to Alerts in Falcon, as `PATCH /alerts/entities/alerts/v3` takes it. Fields left
 * undefined are left as they are.
 */
export type AlertPatch = {
  /** Falcon's status: `new`, `in_progress`, `reopened` or `closed`. */
  status?: string;
  /** Added to the Alert's comments. */
  comment?: string;
  /** The Falcon user to assign to, by UUID; null unassigns. */
  assignTo?: string | null;
};

/** One comment on an Alert in Falcon. */
export type FalconComment = {
  /** Its identity in Falcon: what synced comments are de-duplicated by. */
  id: string;
  /** The Falcon user who made it, if Falcon said. */
  author: string | null;
  body: string;
  /** When it was made, if Falcon said. */
  createdAt: Date | null;
};

export interface FalconClient {
  /** Opens an Event Streams session. Rejects when the credentials are refused or Event Streams isn't enabled. */
  openStream(): Promise<StreamSession>;
  /** Keeps `session` alive for another `refreshIntervalMs`. */
  refreshStream(session: StreamSession): Promise<void>;
  /**
   * Every event from `offset` on, oldest first, of every type: the worker needs each offset to
   * notice gaps, and keeps only the detection events. Ends when Falcon closes the stream; stops when
   * `signal` aborts.
   */
  consume(session: StreamSession, offset: number, signal: AbortSignal): AsyncIterable<StreamEvent>;
  /** Applies `patch` to the Alerts with these composite IDs. Rejects when Falcon refuses or fails. */
  updateAlerts(compositeIds: readonly string[], patch: AlertPatch): Promise<void>;
  /** The UUID of the Falcon user whose login is `email`, or null when there is none. */
  findUser(email: string): Promise<string | null>;
  /** The comments on the Alert with this composite ID, oldest first; none if Falcon has no such Alert. */
  alertComments(compositeId: string): Promise<FalconComment[]>;
  /** The custom IOC of this type and value, or null when Falcon holds none. */
  findIoc(type: FalconIocType, value: string): Promise<FalconIoc | null>;
  /** Creates the custom IOC; resolves to Falcon's id for it. Rejects when Falcon refuses or fails. */
  createIoc(ioc: NewIoc): Promise<string>;
  /**
   * Deletes the custom IOC with this id. Resolves to true when Falcon deleted it, false when Falcon
   * holds no such IOC (it is already gone). Rejects when Falcon refuses or fails.
   */
  deleteIoc(id: string): Promise<boolean>;
  /**
   * What Falcon reports now about each of these devices (`aid`s). A device Falcon doesn't know is
   * left out. Rejects with `FalconScopeMissing` when the API client lacks Hosts: Read.
   */
  hosts(deviceIds: readonly string[]): Promise<FalconHost[]>;
  /**
   * The `aid`s, lower case, of every device Falcon knows by this hostname; none when it knows none.
   * Rejects with `FalconScopeMissing` when the API client lacks Hosts: Read.
   */
  findHosts(hostname: string): Promise<string[]>;
  /**
   * Asks Falcon to contain the device with this `aid`, cutting it off from the network but for
   * Falcon itself. Rejects with `FalconScopeMissing` when the API client lacks Hosts: Write, and
   * otherwise when Falcon refuses or fails.
   */
  containHost(deviceId: string): Promise<void>;
  /**
   * Asks Falcon to lift containment from the device with this `aid`, putting it back on the network.
   * Rejects with `FalconScopeMissing` when the API client lacks Hosts: Write, and otherwise when
   * Falcon refuses or fails.
   */
  liftContainment(deviceId: string): Promise<void>;
  /**
   * What Identity Protection reports now about each of these identities (entity IDs). An identity
   * Falcon doesn't know is left out. Rejects with `FalconScopeMissing` when the API client lacks
   * Identity Protection Entities: Read, or the subscription lacks Identity Protection.
   */
  identities(entityIds: readonly string[]): Promise<FalconIdentity[]>;
  /**
   * The entity IDs of every user identity Identity Protection knows by this account name; none when
   * it knows none. Rejects with `FalconScopeMissing` as `identities` does.
   */
  findIdentities(name: AccountName): Promise<string[]>;
}

/**
 * An account Asset's name as Identity Protection is searched by it (ADR 0009): a UPN or email
 * address, a domain and SAM account name (`DOMAIN\user`), or a SAM account name alone, which
 * several identities in different domains may share.
 */
export type AccountName = { upn: string } | { domain: string; samAccountName: string } | { samAccountName: string };

/** One of an identity's risk factors, as Identity Protection names and grades it. */
export type FalconRiskFactor = { type: string; severity: string | null };

/**
 * One user identity as Identity Protection reports it: what identity Enrichment shows. Anything
 * Falcon didn't say is null (or empty).
 */
export type FalconIdentity = {
  entityId: string;
  displayName: string | null;
  upn: string | null;
  samAccountName: string | null;
  /** 0 to 1, as Falcon scores it. */
  riskScore: number | null;
  /** Falcon's grade of the score: "NORMAL", "MEDIUM" or "HIGH". */
  riskSeverity: string | null;
  riskFactors: FalconRiskFactor[];
  enabled: boolean | null;
  lockedOut: boolean | null;
  stale: boolean | null;
  privileged: boolean | null;
  /** The privileged groups the identity is in, by name. */
  privilegedGroups: string[];
  watched: boolean | null;
  passwordLastSet: string | null;
  passwordNeverExpires: boolean | null;
  lastActivity: string | null;
  email: string | null;
  department: string | null;
  title: string | null;
  domain: string | null;
  ou: string | null;
  /** The endpoints associated with the identity, by hostname. Never linked as Assets. */
  endpoints: string[];
};

/** Falcon refused a call because the API client lacks the scope it needs. */
export class FalconScopeMissing extends Error {}

/** Falcon's containment states for a host. */
export const FALCON_CONTAINMENT = ["normal", "containment_pending", "contained", "lift_containment_pending"] as const;
export type FalconContainment = (typeof FALCON_CONTAINMENT)[number];

/**
 * One device as the Hosts API reports it: what host Enrichment shows. Anything Falcon didn't say is
 * null (or empty).
 */
export type FalconHost = {
  deviceId: string;
  hostname: string | null;
  platform: string | null;
  osVersion: string | null;
  sensorVersion: string | null;
  /** The sensor's state: "Normal", "Reduced functionality mode", or Falcon's provisioning status. */
  sensorStatus: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  localIp: string | null;
  externalIp: string | null;
  macAddress: string | null;
  domain: string | null;
  ou: string[];
  site: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  lastLoggedOnUser: string | null;
  /** Host group names, or ids where Falcon wouldn't say the name. */
  hostGroups: string[];
  tags: string[];
  containment: FalconContainment | null;
};

/** The platforms a custom IOC applies to: all of them. */
export const IOC_PLATFORMS = ["windows", "mac", "linux"] as const;

/** A custom IOC as Argus creates it in Falcon. */
export type NewIoc = {
  type: FalconIocType;
  value: string;
  action: FalconIocAction;
  severity: Severity;
  platforms: readonly string[];
  appliedGlobally: true;
  source: string;
  description: string;
};

/** A custom IOC Falcon holds. */
export type FalconIoc = NewIoc & { id: string };

/** Makes the client for one Integration. */
export type FalconConnector = (connection: FalconConnection) => FalconClient;
