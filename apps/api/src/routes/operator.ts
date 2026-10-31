import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { OPERATOR_ROLE } from "../auth/roles";
import type { Env } from "../deps";
import type { Modules } from "../modules";

const createOrganizationBody = z.object({
  name: z.string().trim().min(1).max(120),
  ownerEmail: z.email().trim().toLowerCase(),
});

const requireOperator = createMiddleware<Env>(async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Not signed in" }, 401);
  if (user.role !== OPERATOR_ROLE) return c.json({ error: "Operators only" }, 403);
  await next();
});

/** The Operator console: Organizations across the whole service. */
export const operatorRoutes = ({ organizations }: Modules) =>
  new Hono<Env>()
    .use(requireOperator)
    .get("/organizations", async (c) => {
      return c.json({ organizations: await organizations.list() }, 200);
    })
    .post("/organizations", zValidator("json", createOrganizationBody), async (c) => {
      const organization = await organizations.create(c.get("user")!, c.req.valid("json"));
      return c.json({ organization }, 201);
    });
