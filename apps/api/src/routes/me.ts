import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { OPERATOR_ROLE } from "../auth/roles";
import { member, organization } from "../db/schema";
import type { Deps, Env } from "../deps";

export const meRoutes = ({ db }: Deps) =>
  new Hono<Env>().get("/", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Not signed in" }, 401);
    const [membership] = await db
      .select({ id: organization.id, name: organization.name, role: member.role })
      .from(member)
      .innerJoin(organization, eq(member.organizationId, organization.id))
      .where(eq(member.userId, user.id))
      .limit(1);
    return c.json(
      {
        user: { id: user.id, name: user.name, email: user.email },
        isOperator: user.role === OPERATOR_ROLE,
        organization: membership ?? null,
      },
      200,
    );
  });
