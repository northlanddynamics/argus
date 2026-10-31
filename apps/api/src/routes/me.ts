import { Hono } from "hono";
import { OPERATOR_ROLE } from "../auth/roles";
import { TOTP_ENROLLMENT_REQUIRED } from "../auth/totp-enrollment";
import type { Deps, Env } from "../deps";
import { findMembership } from "../members/membership";

export const meRoutes = ({ db }: Deps) =>
  new Hono<Env>().get("/", async (c) => {
    if (c.get("totpEnrollmentPending")) {
      return c.json({ error: "Set up two-factor authentication to continue", code: TOTP_ENROLLMENT_REQUIRED }, 403);
    }
    const user = c.get("user");
    if (!user) return c.json({ error: "Not signed in" }, 401);
    const membership = await findMembership(db, user.id);
    return c.json(
      {
        user: { id: user.id, name: user.name, email: user.email },
        isOperator: user.role === OPERATOR_ROLE,
        organization: membership ? { id: membership.organizationId, name: membership.organizationName, role: membership.role } : null,
      },
      200,
    );
  });
