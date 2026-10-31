import { Hono } from "hono";
import type { Deps, Env } from "./deps";
import { invitationRoutes } from "./routes/invitations";
import { meRoutes } from "./routes/me";
import { operatorRoutes } from "./routes/operator";

/** Builds the HTTP API. Everything outside the process comes in through `deps`. */
export function createApi(deps: Deps) {
  const { auth } = deps;
  return new Hono<Env>()
    .basePath("/api")
    .on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw))
    .use(async (c, next) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      c.set("user", session?.user ?? null);
      await next();
    })
    .route("/me", meRoutes(deps))
    .route("/operator", operatorRoutes(deps))
    .route("/invitations", invitationRoutes(deps));
}

export type ApiType = ReturnType<typeof createApi>;
