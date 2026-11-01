import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { OPERATOR_ROLE } from "../auth/roles";
import { TOTP_ENROLLMENT_REQUIRED } from "../auth/totp-enrollment";
import type { Deps, Env } from "../deps";
import { guestCasesOf } from "../guests/grants";
import { chooseOrganization } from "../guests/guest-sessions";
import { findGuestPass, findMembership } from "../members/membership";

const organizationBody = z.object({ organizationId: z.string().min(1) });

export const meRoutes = ({ db, clock }: Deps) =>
  new Hono<Env>()
    .get("/", async (c) => {
      if (c.get("totpEnrollmentPending")) {
        return c.json({ error: "Set up two-factor authentication to continue", code: TOTP_ENROLLMENT_REQUIRED }, 403);
      }
      const user = c.get("user");
      if (!user) return c.json({ error: "Not signed in" }, 401);
      const membership = await findMembership(db, user.id);
      const session = c.get("guestSession");
      const now = clock.now();
      const pass = session && (await findGuestPass(db, { userId: user.id, name: user.name }, session.organizationId, now));
      return c.json(
        {
          user: { id: user.id, name: user.name, email: user.email },
          isOperator: user.role === OPERATOR_ROLE,
          organization: membership ? { id: membership.organizationId, name: membership.organizationName, role: membership.role } : null,
          /**
           * For a Guest: the Organization they are working in, every Case granted to them, and when their
           * session ends, with the server's time (`asOf`) to count down from.
           */
          guest: session
            ? {
                organization: pass ? { id: pass.organizationId, name: pass.organizationName } : null,
                cases: await guestCasesOf(db, user.id, now),
                sessionEndsAt: session.expiresAt.toISOString(),
                asOf: now.toISOString(),
              }
            : null,
        },
        200,
      );
    })
    /** A Guest switches to another Organization that granted them a Case. */
    .put("/organization", zValidator("json", organizationBody), async (c) => {
      const user = c.get("user");
      const session = c.get("guestSession");
      if (!user) return c.json({ error: "Not signed in" }, 401);
      if (!session) return c.json({ error: "Only Guests switch Organization" }, 403);
      const chosen = await chooseOrganization(db, clock.now(), { sessionId: session.sessionId, userId: user.id }, c.req.valid("json").organizationId);
      if (!chosen) return c.json({ error: "You have no Cases in that Organization" }, 404);
      return c.json({ organizationId: c.req.valid("json").organizationId }, 200);
    });
