import { hostname } from "node:os";
import { depsFromEnv } from "./config";
import { falconHttpClient } from "./crowdstrike/falcon-http";
import { createCommentSyncer } from "./crowdstrike/comment-sync";
import { createStreamWorker, STREAM_TICK_MS } from "./crowdstrike/stream-worker";
import { createWriteBackSender } from "./crowdstrike/write-back";
import { runMigrations } from "./db/migrate";
import { createNotificationWorker } from "./notifications/notifications";

/**
 * The `worker` process (ADR 0001): same image as `web`, started with `bun apps/api/src/worker.ts`.
 * Holds the CrowdStrike Event Streams connections, sends write-backs to Falcon, fetches Alerts'
 * comments from it, and notifies owners of overdue Tasks; run as many as you like, each stream is
 * owned by one, and each write-back, comment fetch and notification is made by one.
 */
const deps = depsFromEnv();
await runMigrations(deps.db);
const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
const connect = (connection: Parameters<typeof falconHttpClient>[0]) => falconHttpClient(connection);
const worker = createStreamWorker(deps, { connect, workerId });
const writeBacks = createWriteBackSender(deps, { connect });
const comments = createCommentSyncer(deps, { connect });
const notifications = createNotificationWorker(deps);

const tick = () =>
  Promise.all([
    worker.tick().catch((e: unknown) => console.error("worker:", e)),
    writeBacks.tick().catch((e: unknown) => console.error("worker: write-back:", e)),
    comments.tick().catch((e: unknown) => console.error("worker: comments:", e)),
    notifications.tick().catch((e: unknown) => console.error("worker: notifications:", e)),
  ]);
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
