import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { OrgRole } from "../auth/roles";
import { invitation, organization, user as userTable } from "../db/schema";
import type { Deps, Env } from "../deps";

const acceptBody = z.object({
  name: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(128),
});

export const invitationRoutes = ({ db, auth, clock }: Deps) => {
  const findOpen = async (id: string) => {
    const [row] = await db
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        organizationId: organization.id,
        organizationName: organization.name,
      })
      .from(invitation)
      .innerJoin(organization, eq(invitation.organizationId, organization.id))
      .where(eq(invitation.id, id))
      .limit(1);
    if (!row || row.status !== "pending") return { error: "not_found" as const };
    if (row.expiresAt <= clock.now()) return { error: "expired" as const };
    return { invite: row };
  };

  return new Hono<Env>()
    .get("/:id", async (c) => {
      const found = await findOpen(c.req.param("id"));
      if (found.error === "not_found") return c.json({ error: "Invitation not found" }, 404);
      if (found.error === "expired") return c.json({ error: "Invitation expired" }, 410);
      const { invite } = found;
      return c.json(
        { email: invite.email, role: invite.role, organization: { name: invite.organizationName } },
        200,
      );
    })
    .post("/:id/accept", zValidator("json", acceptBody), async (c) => {
      const found = await findOpen(c.req.param("id"));
      if (found.error === "not_found") return c.json({ error: "Invitation not found" }, 404);
      if (found.error === "expired") return c.json({ error: "Invitation expired" }, 410);
      const { invite } = found;
      const { name, password } = c.req.valid("json");

      const existing = await db.query.user.findFirst({ where: eq(userTable.email, invite.email) });
      if (existing) return c.json({ error: "An account already exists for this email" }, 409);

      // Server-side calls: no session, so Better Auth treats them as trusted.
      const { user } = await auth.api.createUser({
        body: { email: invite.email, password, name, role: "user", data: { emailVerified: true } },
      });
      await auth.api.addMember({
        body: { userId: user.id, organizationId: invite.organizationId, role: (invite.role ?? "analyst") as OrgRole },
      });
      await db.update(invitation).set({ status: "accepted" }).where(eq(invitation.id, invite.id));
      return c.json({ email: invite.email }, 200);
    });
};
