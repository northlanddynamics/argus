import { defaultWebDist, depsFromEnv } from "./config";
import { runMigrations } from "./db/migrate";
import { createServerApp } from "./server-app";

const deps = depsFromEnv();
await runMigrations(deps.db);
const app = createServerApp(deps, defaultWebDist);
const server = Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: app.fetch });
console.log(`Argus listening on ${server.url}`);
