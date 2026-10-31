import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { OPERATOR_ROLE } from "../auth/roles";
import { invitation, member, organization, user as userTable } from "../db/schema";
import type { Deps, Env } from "../deps";
import { secureId } from "../ids";
import { sendOwnerInvite } from "../invites";

const createOrganizationBody = z.object({
  name: z.string().trim().min(1).max(120),
  ownerEmail: z.email().trim().toLowerCase(),
});

const slugify = (name: string) =>
  `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)}-${secureId().slice(0, 6).toLowerCase()}`;

export const operatorRoutes = (deps: Deps) => {
  const { db, clock } = deps;

  const requireOperator = createMiddleware<Env>(async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Not signed in" }, 401);
    if (user.role !== OPERATOR_ROLE) return c.json({ error: "Operators only" }, 403);
    await next();
  });

  return new Hono<Env>()
    .use(requireOperator)
    .get("/organizations", async (c) => {
      const orgs = await db.select().from(organization).orderBy(desc(organization.createdAt));
      const result = await Promise.all(
        orgs.map(async (org) => {
          const [owner] = await db
            .select({ email: userTable.email })
            .from(member)
            .innerJoin(userTable, eq(member.userId, userTable.id))
            .where(and(eq(member.organizationId, org.id), eq(member.role, "owner")))
            .limit(1);
          const [pending] = await db
            .select({ email: invitation.email })
            .from(invitation)
            .where(
              and(
                eq(invitation.organizationId, org.id),
                eq(invitation.role, "owner"),
                eq(invitation.status, "pending"),
              ),
            )
            .orderBy(desc(invitation.createdAt))
            .limit(1);
          const [memberCount] = await db
            .select({ count: count() })
            .from(member)
            .where(eq(member.organizationId, org.id));
          return {
            id: org.id,
            name: org.name,
            createdAt: org.createdAt.toISOString(),
            members: memberCount?.count ?? 0,
            owner: owner
              ? { email: owner.email, status: "active" as const }
              : pending
                ? { email: pending.email, status: "invited" as const }
                : null,
          };
        }),
      );
      return c.json({ organizations: result }, 200);
    })
    .post("/organizations", zValidator("json", createOrganizationBody), async (c) => {
      const operator = c.get("user")!;
      const { name, ownerEmail } = c.req.valid("json");
      const now = clock.now();
      const org = { id: secureId(), name, slug: slugify(name), createdAt: now };
      const invite = await db.transaction(async (tx) => {
        await tx.insert(organization).values(org);
        const [row] = await tx
          .insert(invitation)
          .values({
            id: secureId(),
            organizationId: org.id,
            email: ownerEmail,
            role: "owner",
            status: "pending",
            createdAt: now,
            expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
            inviterId: operator.id,
          })
          .returning();
        return row!;
      });
      await sendOwnerInvite(deps, { invitationId: invite.id, email: ownerEmail, organizationName: name });
      return c.json({ organization: { id: org.id, name: org.name } }, 201);
    });
};

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
