/**
 * The live socket's wire protocol (ADR 0005), shared by the API and the SPA.
 *
 * The server only ever says what changed; clients refetch through the HTTP API, so every visibility
 * rule stays in one place. Presence is the exception: it is not in the HTTP API, so it travels whole.
 */

/** Where a signed-in Member opens their one socket. */
export const LIVE_PATH = "/api/live";

export type Viewer = { id: string; name: string };

export type ServerMessage =
  /** Case `number` changed (or was opened): refetch it and the Case list. */
  | { type: "case"; number: number }
  /** Who is viewing Case `number` now; sent to sockets viewing it whenever that changes. */
  | { type: "presence"; number: number; viewers: Viewer[] }
  /** The Alert queue or an Integration changed: refetch them. Members only. */
  | { type: "alerts" }
  /** Signals may have been missed, or what you can see changed: refetch everything on screen. */
  | { type: "resync" };

export type ClientMessage =
  /** The Case page this socket is on, or null when it leaves Case pages. */
  { type: "view"; number: number | null };
