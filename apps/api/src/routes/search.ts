import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../deps";
import { type ParticipantEnv, requireParticipant } from "../members/membership";
import type { Modules } from "../modules";

const searchQuery = z.object({ q: z.string().max(200) });

/** Global search, for Members and Guests; what each finds is up to the access policy. */
export const searchRoutes = (deps: Deps, { search }: Modules) =>
  new Hono<ParticipantEnv>()
    .use(requireParticipant(deps))
    .get("/", zValidator("query", searchQuery), async (c) => c.json({ results: await search.search(c.get("participant"), c.req.valid("query").q) }, 200));
