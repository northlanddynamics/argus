import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../deps";
import { type ParticipantEnv, requireParticipant } from "../members/membership";
import type { Modules } from "../modules";

const idParam = z.object({ id: z.string().min(1) });

/** The signed-in Member's or Guest's notifications, in the Organization they are acting in. */
export const notificationRoutes = (deps: Deps, { notifications }: Modules) =>
  new Hono<ParticipantEnv>()
    .use(requireParticipant(deps))
    .get("/", async (c) => c.json(await notifications.list(c.get("participant")), 200))
    .post("/read", async (c) => {
      await notifications.markAllRead(c.get("participant"));
      return c.json(await notifications.list(c.get("participant")), 200);
    })
    .post("/:id/read", zValidator("param", idParam), async (c) => {
      const me = c.get("participant");
      if (!(await notifications.markRead(me, c.req.valid("param").id))) return c.json({ error: "Notification not found" }, 404);
      return c.json(await notifications.list(me), 200);
    });
