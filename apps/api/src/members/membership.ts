import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { OrgRole } from "../auth/roles";
import type { Db } from "../db/client";
import { member, organization } from "../db/schema";
import type { Env } from "../deps";

/** The signed-in person's place in their Organization. */
export type Membership = {
  memberId: string;
  organizationId: string;
  organizationName: string;
  role: OrgRole;
  userId: string;
  name: string;
};

export type MemberEnv = { Variables: Env["Variables"] & { membership: Membership } };

/** The one Organization `userId` is a Member of, unless it has been deleted. */
export async function findMembership(db: Db, userId: string) {
  const [row] = await db
    .select({
      memberId: member.id,
      organizationId: organization.id,
      organizationName: organization.name,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(and(eq(member.userId, userId), isNull(organization.deletedAt)))
    .limit(1);
  return row ? { ...row, role: row.role as OrgRole } : null;
}

/** Lets through signed-in Members (optionally only those with one of `roles`) and sets `membership`. */
export const requireMember = (db: Db, roles?: OrgRole[]) =>
  createMiddleware<MemberEnv>(async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Not signed in" }, 401);
    const found = await findMembership(db, user.id);
    if (!found) return c.json({ error: "Not a Member of an Organization" }, 403);
    if (roles && !roles.includes(found.role)) return c.json({ error: "Not permitted" }, 403);
    c.set("membership", { ...found, userId: user.id, name: user.name });
    await next();
  });

export const MANAGERS: OrgRole[] = ["owner", "admin"];
