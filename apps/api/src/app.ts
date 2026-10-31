import { Hono } from "hono";
import { totpEnrollmentPending } from "./auth/totp-enrollment";
import type { Deps, Env } from "./deps";
import { createLive, type Live } from "./realtime/live";
import { caseRoutes } from "./routes/cases";
import { invitationRoutes } from "./routes/invitations";
import { liveRoutes } from "./routes/live";
import { meRoutes } from "./routes/me";
import { operatorRoutes } from "./routes/operator";
import { organizationRoutes } from "./routes/organization";

/**
 * Builds the HTTP API. Everything outside the process comes in through `deps`; `live` is this
 * process's live hub, made here unless the caller runs its heartbeat (see `realtime/live.ts`).
 */
export function createApi(deps: Deps, live: Live = createLive(deps)) {
  const { auth } = deps;
  return new Hono<Env>()
    .basePath("/api")
    .on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw))
    .use(async (c, next) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      // A Member who still has to enroll in TOTP is not signed in as far as Argus is concerned.
      const pending = !!session && totpEnrollmentPending(session);
      c.set("user", pending ? null : (session?.user ?? null));
      c.set("totpEnrollmentPending", pending);
      await next();
    })
    .route("/me", meRoutes(deps))
    .route("/operator", operatorRoutes(deps))
    .route("/invitations", invitationRoutes(deps))
    .route("/organization", organizationRoutes(deps))
    .route("/cases", caseRoutes(deps))
    .route("/live", liveRoutes(deps, live));
}

export type ApiType = ReturnType<typeof createApi>;
