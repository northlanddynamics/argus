import { websocket } from "@hono/bun";
import { defaultWebDist, depsFromEnv } from "./config";
import { runMigrations } from "./db/migrate";
import { createLive, PRESENCE_HEARTBEAT_MS } from "./realtime/live";
import { createServerApp } from "./server-app";

const deps = depsFromEnv();
await runMigrations(deps.db);
const live = createLive(deps);
await live.ready;
setInterval(() => void live.sweep(), PRESENCE_HEARTBEAT_MS);
const app = createServerApp(deps, defaultWebDist, live);
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
  websocket,
  // Evidence uploads stream the file as the request body; the Evidence module enforces the limit itself.
  maxRequestBodySize: deps.evidence.maxBytes + 1,
});
console.log(`Argus listening on ${server.url}`);
