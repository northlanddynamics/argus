import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../deps";
import { AccountExists, InvitationExpired, InvitationNotFound } from "../invitations/invitations";
import type { Modules } from "../modules";

const acceptBody = z.object({
  name: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(128),
});

/** Viewing and accepting an invitation, before the person has an account. */
export const invitationRoutes = ({ invitations }: Modules) =>
  new Hono<Env>()
    .get("/:id", async (c) => {
      try {
        return c.json(await invitations.open(c.req.param("id")), 200);
      } catch (e) {
        if (e instanceof InvitationNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof InvitationExpired) return c.json({ error: e.message }, 410);
        throw e;
      }
    })
    .post("/:id/accept", zValidator("json", acceptBody), async (c) => {
      try {
        return c.json(await invitations.accept(c.req.param("id"), c.req.valid("json")), 200);
      } catch (e) {
        if (e instanceof InvitationNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof InvitationExpired) return c.json({ error: e.message }, 410);
        if (e instanceof AccountExists) return c.json({ error: e.message }, 409);
        throw e;
      }
    });
