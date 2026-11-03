import type { FalconCloud } from "../alerts/vocabulary";

/**
 * The Falcon API as Argus uses it (ADR 0002): an adapter, so the worker runs against the real API
 * (`falcon-http.ts`) in production and a fake stream in tests (`test/fake-falcon.ts`).
 *
 * Event Streams in; Alert updates and user lookup out, for the write-back outbox
 * (`write-back.ts`), which writes nothing for an Integration whose `writeBack` is off.
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
}

/** Makes the client for one Integration. */
export type FalconConnector = (connection: FalconConnection) => FalconClient;
