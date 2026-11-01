import type { FalconCloud } from "../alerts/vocabulary";

/**
 * The Falcon API as Argus uses it (ADR 0002): an adapter, so the worker runs against the real API
 * (`falcon-http.ts`) in production and a fake stream in tests (`test/fake-falcon.ts`).
 *
 * Only Event Streams for now; Alert write-back, comments and user lookup join it with the outbox.
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
}

/** Makes the client for one Integration. */
export type FalconConnector = (connection: FalconConnection) => FalconClient;
