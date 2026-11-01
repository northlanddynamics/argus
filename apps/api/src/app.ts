import { Hono } from "hono";
import { totpEnrollmentPending } from "./auth/totp-enrollment";
import type { Deps, Env } from "./deps";
import { guestSession, isGuestAccount } from "./guests/guest-sessions";
import { createModules } from "./modules";
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
  const { auth, db, clock } = deps;
  const modules = createModules(deps);
  return new Hono<Env>()
    .basePath("/api")
    .on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw))
    .use(async (c, next) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      // A Member who still has to enroll in TOTP is not signed in as far as Argus is concerned.
      const pending = !!session && totpEnrollmentPending(session);
      let user = pending ? null : (session?.user ?? null);
      let guest = null;
      if (session && user && (await isGuestAccount(db, user))) {
        // A Guest whose session has run out is signed out.
        guest = await guestSession(db, clock.now(), { sessionId: session.session.id, userId: user.id });
        if (!guest) user = null;
      }
      c.set("user", user);
      c.set("totpEnrollmentPending", pending);
      c.set("guestSession", guest);
      await next();
    })
    .route("/me", meRoutes(deps))
    .route("/operator", operatorRoutes(modules))
    .route("/invitations", invitationRoutes(modules))
    .route("/organization", organizationRoutes(deps, modules))
    .route("/cases", caseRoutes(deps, modules))
    .route("/live", liveRoutes(deps, live));
}

export type ApiType = ReturnType<typeof createApi>;
