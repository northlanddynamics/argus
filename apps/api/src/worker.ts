import { hostname } from "node:os";
import { depsFromEnv } from "./config";
import { falconHttpClient } from "./crowdstrike/falcon-http";
import { createStreamWorker, STREAM_TICK_MS } from "./crowdstrike/stream-worker";
import { runMigrations } from "./db/migrate";

/**
 * The `worker` process (ADR 0001): same image as `web`, started with `bun apps/api/src/worker.ts`.
 * Holds the CrowdStrike Event Streams connections; run as many as you like, each stream is owned by one.
 */
const deps = depsFromEnv();
await runMigrations(deps.db);
const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
const worker = createStreamWorker(deps, { connect: (connection) => falconHttpClient(connection), workerId });

const tick = () => worker.tick().catch((e: unknown) => console.error("worker:", e));
await tick();
const timer = setInterval(tick, STREAM_TICK_MS);
console.log(`Argus worker ${workerId} running`);

const shutDown = async () => {
  clearInterval(timer);
  await worker.close();
  await deps.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutDown());
process.on("SIGINT", () => void shutDown());
