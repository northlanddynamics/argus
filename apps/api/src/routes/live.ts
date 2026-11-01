import { upgradeWebSocket } from "@hono/bun";
import { Hono } from "hono";
import type { Deps } from "../deps";
import { type ParticipantEnv, requireParticipant } from "../members/membership";
import type { Live } from "../realtime/live";

/**
 * The live socket (ADR 0005): one per signed-in Member's or Guest's browser. Served by Bun, so the server
 * needs `websocket` from `@hono/bun`. Protocol in `realtime/messages.ts`.
 */
export const liveRoutes = (deps: Deps, live: Live) => {
  const origin = new URL(deps.baseUrl).origin;
  return new Hono<ParticipantEnv>().get(
    "/",
    requireParticipant(deps),
    // Browsers send cookies on cross-site WebSocket handshakes too; only our own pages may connect.
    async (c, next) => {
      if (c.req.header("origin") !== origin) return c.json({ error: "Cross-origin connections are not allowed" }, 403);
      await next();
    },
    upgradeWebSocket((c) => {
      const me = c.get("participant");
      const who =
        me.role === "guest"
          ? { ...me, until: c.get("guestSession")?.expiresAt }
          : { organizationId: me.organizationId, userId: me.userId, role: me.role, name: me.name };
      let connection: ReturnType<Live["connect"]> | undefined;
      return {
        onOpen(_event, ws) {
          connection = live.connect(
            who,
            { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) },
          );
        },
        onMessage(event) {
          if (typeof event.data === "string") connection?.receive(event.data);
        },
        onClose() {
          connection?.closed();
        },
      };
    }),
  );
};
