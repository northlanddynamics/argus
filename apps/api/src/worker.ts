import { hostname } from "node:os";
import { depsFromEnv } from "./config";
import { falconHttpClient } from "./crowdstrike/falcon-http";
import { createCommentSyncer } from "./crowdstrike/comment-sync";
import { createStreamWorker, STREAM_TICK_MS } from "./crowdstrike/stream-worker";
import { createWriteBackSender } from "./crowdstrike/write-back";
import { runMigrations } from "./db/migrate";
import { createMimecastHealthChecker } from "./mimecast/health";
import { mimecastHttpClient } from "./mimecast/mimecast-http";
import { createNotificationWorker } from "./notifications/notifications";
import { createResponseActionSender } from "./response-actions/sender";
import { createTeamsSender } from "./teams/teams";

/**
 * The `worker` process (ADR 0001): same image as `web`, started with `bun apps/api/src/worker.ts`.
 * Holds the CrowdStrike Event Streams connections, sends write-backs and Response Actions to Falcon,
 * sends Response Actions to Mimecast and checks Mimecast Integrations' credentials, fetches Alerts' comments from Falcon, notifies owners of overdue Tasks and retries Teams channel posts;
 * run as many as you like, each stream is owned by one, and each write-back, Response Action,
 * comment fetch, notification and Teams post is made by one.
 */
const deps = depsFromEnv();
await runMigrations(deps.db);
const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
const connect = (connection: Parameters<typeof falconHttpClient>[0]) => falconHttpClient(connection);
const worker = createStreamWorker(deps, { connect, workerId });
const writeBacks = createWriteBackSender(deps, { connect });
const comments = createCommentSyncer(deps, { connect });
const mimecast = (credentials: Parameters<typeof mimecastHttpClient>[0]) => mimecastHttpClient(credentials);
const responseActions = createResponseActionSender(deps, { connect, mimecast });
const mimecastHealth = createMimecastHealthChecker(deps, { connect: mimecast });
const notifications = createNotificationWorker(deps);
const teams = createTeamsSender(deps);

const tick = () =>
  Promise.all([
    worker.tick().catch((e: unknown) => console.error("worker:", e)),
    writeBacks.tick().catch((e: unknown) => console.error("worker: write-back:", e)),
    comments.tick().catch((e: unknown) => console.error("worker: comments:", e)),
    responseActions.tick().catch((e: unknown) => console.error("worker: response actions:", e)),
    mimecastHealth.tick().catch((e: unknown) => console.error("worker: mimecast health:", e)),
    notifications.tick().catch((e: unknown) => console.error("worker: notifications:", e)),
    teams.tick().catch((e: unknown) => console.error("worker: teams:", e)),
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
