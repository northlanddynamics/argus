import type { QueryClient } from "@tanstack/react-query";
import { type ClientMessage, LIVE_PATH, type ServerMessage, type Viewer } from "api/realtime/messages";
import { useEffect, useSyncExternalStore } from "react";
import { alertsKey, integrationsKey } from "@/lib/alerts";
import { casesKey } from "@/lib/cases";
import { queryClient } from "@/lib/query-client";

export type { Viewer };

/**
 * The SPA's one live socket (ADR 0005). Signals only say what changed; this invalidates the
 * matching queries and TanStack Query refetches them through the HTTP API.
 *
 * Pages that want live updates hold the connection open with `useLiveStatus` or `useCasePresence`;
 * it closes shortly after the last one goes, and reconnects with backoff when it drops.
 */

/** "reconnected" shows for a few seconds after a reconnect, once views have been refreshed. */
export type LiveStatus = "connecting" | "live" | "reconnecting" | "reconnected";

const LINGER_MS = 2_000;
const RECONNECTED_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
const NO_VIEWERS: Viewer[] = [];

class LiveConnection {
  #ws: WebSocket | null = null;
  #holders = 0;
  #lingerTimer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #attempts = 0;
  /** Whether this connection has been open before, so the next open is a reconnect. */
  #wasOpen = false;
  #viewing: number | null = null;
  #presence = new Map<number, Viewer[]>();
  #status: LiveStatus = "connecting";
  #listeners = new Set<() => void>();

  readonly #queries: QueryClient;
  constructor(queries: QueryClient) {
    this.#queries = queries;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  status = () => this.#status;
  viewers = (number: number) => this.#presence.get(number) ?? NO_VIEWERS;

  /** Keeps the connection open until the returned function is called. */
  hold() {
    this.#holders++;
    clearTimeout(this.#lingerTimer);
    if (!this.#ws && !this.#retryTimer) this.#open();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.#holders === 0) this.#lingerTimer = setTimeout(() => this.#shut(), LINGER_MS);
    };
  }

  /** Tells the server which Case page this tab is on, for presence. */
  view(number: number | null) {
    this.#viewing = number;
    this.#send({ type: "view", number });
  }

  #notify() {
    for (const listener of this.#listeners) listener();
  }

  #setStatus(status: LiveStatus) {
    this.#status = status;
    this.#notify();
  }

  #send(message: ClientMessage) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
  }

  #open() {
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${scheme}//${window.location.host}${LIVE_PATH}`);
    this.#ws = ws;
    ws.addEventListener("open", () => {
      this.#attempts = 0;
      if (this.#viewing !== null) this.#send({ type: "view", number: this.#viewing });
      if (!this.#wasOpen) {
        this.#wasOpen = true;
        this.#setStatus("live");
        return;
      }
      // Signals sent while we were away are lost: refetch everything on screen.
      void this.#queries.invalidateQueries();
      this.#setStatus("reconnected");
      setTimeout(() => {
        if (this.#status === "reconnected") this.#setStatus("live");
      }, RECONNECTED_MS);
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.#receive(JSON.parse(event.data) as ServerMessage);
    });
    ws.addEventListener("close", () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#presence.clear();
      this.#setStatus(this.#wasOpen ? "reconnecting" : "connecting");
      // Also after the server closed it on purpose (no longer a Member): the retry then fails until
      // they sign in again, and the refetch on reconnect shows them what they may see by then.
      const backoff = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** this.#attempts++);
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = undefined;
        if (this.#holders > 0) this.#open();
      }, backoff * (0.5 + Math.random() / 2));
    });
  }

  #shut() {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
    this.#wasOpen = false;
    this.#attempts = 0;
    this.#presence.clear();
    this.#setStatus("connecting");
  }

  #receive(message: ServerMessage) {
    switch (message.type) {
      case "case":
        // The Case list (every view and filter) and everything under this Case.
        void this.#queries.invalidateQueries({
          queryKey: casesKey,
          predicate: ({ queryKey }) => typeof queryKey[1] !== "number" || queryKey[1] === message.number,
        });
        return;
      case "alerts":
        void this.#queries.invalidateQueries({ queryKey: alertsKey });
        void this.#queries.invalidateQueries({ queryKey: integrationsKey });
        return;
      case "presence":
        this.#presence.set(message.number, message.viewers);
        this.#notify();
        return;
      case "resync":
        void this.#queries.invalidateQueries();
        return;
    }
  }
}

export const live = new LiveConnection(queryClient);

/** Holds the live connection open while mounted, and reports its state. */
export function useLiveStatus() {
  useEffect(() => live.hold(), []);
  return useSyncExternalStore(live.subscribe, live.status);
}

/** Who is viewing Case `number` now, including you; tells the server you are while mounted. */
export function useCasePresence(number: number) {
  useEffect(() => {
    const release = live.hold();
    live.view(number);
    return () => {
      live.view(null);
      release();
    };
  }, [number]);
  return useSyncExternalStore(live.subscribe, () => live.viewers(number));
}
