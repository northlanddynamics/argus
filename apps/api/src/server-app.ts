import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createApi } from "./app";
import type { Deps } from "./deps";

/** The API plus the built SPA from `webDist`, as served in production by one process. */
export function createServerApp(deps: Deps, webDist: string) {
  const app = new Hono().route("/", createApi(deps));
  if (!existsSync(webDist)) return app;
  const indexHtml = readFile(join(webDist, "index.html"), "utf8");
  return app
    .use("/*", serveStatic({ root: webDist }))
    .get("*", async (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(await indexHtml)));
}
