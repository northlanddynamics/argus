import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { NotPermitted } from "../access/policy";
import { ORG_AUDIT_CATEGORIES } from "../audit/org-audit-log";
import type { Deps } from "../deps";
import { EmailTaken, InvitationNotFound } from "../invitations/invitations";
import { type MemberEnv, requireMember } from "../members/membership";
import { AlreadyOwner, MemberNotFound, OwnerProtected } from "../members/members";
import { CaseRoleNameTaken, CaseRoleNotFound, CaseRoleRetired } from "../case-roles/case-roles";
import type { Modules } from "../modules";
import { ConfirmationMismatch } from "../organizations/organizations";

/** Roles an Admin can give. Ownership only moves by transfer. */
const assignableRole = z.enum(["admin", "analyst"]);

const inviteBody = z.object({ email: z.email().trim().toLowerCase(), role: assignableRole });
const roleBody = z.object({ role: assignableRole });
const transferBody = z.object({ memberId: z.string().min(1) });
const deleteBody = z.object({ confirmName: z.string() });
const caseRoleBody = z.object({ name: z.string().trim().min(1).max(60) });
const auditQuery = z.object({
  category: z.enum(ORG_AUDIT_CATEGORIES).optional(),
  actor: z.string().min(1).optional(),
  from: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Not a date")
    .optional(),
});

const notPermitted = { error: "Not permitted" } as const;

/** Settings · Members, the Case Role catalog, Ownership and the Organization Audit Log. */
export const organizationRoutes = (deps: Deps, { members, invitations, organizations, caseRoles }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/members", async (c) => {
      const me = c.get("membership");
      const [all, pending] = await Promise.all([members.list(me), invitations.pending(me)]);
      return c.json({ members: all, invitations: pending }, 200);
    })
    .post("/invitations", zValidator("json", inviteBody), async (c) => {
      const { email, role } = c.req.valid("json");
      try {
        const invitation = await invitations.invite(c.get("membership"), email, role);
        return c.json({ invitation }, 201);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof EmailTaken) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .delete("/invitations/:id", async (c) => {
      try {
        await invitations.revoke(c.get("membership"), c.req.param("id"));
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof InvitationNotFound) return c.json({ error: e.message }, 404);
        throw e;
      }
    })
    .patch("/members/:id", zValidator("json", roleBody), async (c) => {
      try {
        await members.changeRole(c.get("membership"), c.req.param("id"), c.req.valid("json").role);
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof MemberNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof OwnerProtected) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .delete("/members/:id", async (c) => {
      try {
        await members.remove(c.get("membership"), c.req.param("id"));
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof MemberNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof OwnerProtected) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .get("/case-roles", async (c) => {
      return c.json({ caseRoles: await caseRoles.catalog(c.get("membership")) }, 200);
    })
    .post("/case-roles", zValidator("json", caseRoleBody), async (c) => {
      try {
        const created = await caseRoles.create(c.get("membership"), c.req.valid("json").name);
        return c.json({ caseRole: created }, 201);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof CaseRoleNameTaken) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .patch("/case-roles/:id", zValidator("json", caseRoleBody), async (c) => {
      try {
        const renamed = await caseRoles.rename(c.get("membership"), c.req.param("id"), c.req.valid("json").name);
        return c.json({ caseRole: renamed }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof CaseRoleNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof CaseRoleNameTaken || e instanceof CaseRoleRetired) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .post("/case-roles/:id/retire", async (c) => {
      try {
        await caseRoles.retire(c.get("membership"), c.req.param("id"));
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof CaseRoleNotFound) return c.json({ error: e.message }, 404);
        throw e;
      }
    })
    .post("/ownership", zValidator("json", transferBody), async (c) => {
      try {
        await members.transferOwnership(c.get("membership"), c.req.valid("json").memberId);
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof MemberNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof AlreadyOwner) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .delete("/", zValidator("json", deleteBody), async (c) => {
      try {
        await organizations.delete(c.get("membership"), c.req.valid("json").confirmName);
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof ConfirmationMismatch) return c.json({ error: e.message }, 400);
        throw e;
      }
    })
    .get("/audit-log", zValidator("query", auditQuery), async (c) => {
      const { category, actor, from } = c.req.valid("query");
      try {
        const entries = await organizations.auditLog(c.get("membership"), {
          category,
          actorId: actor,
          from: from ? new Date(from) : undefined,
        });
        return c.json({ entries }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        throw e;
      }
    });
