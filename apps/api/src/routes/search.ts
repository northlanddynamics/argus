import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../deps";
import { type ParticipantEnv, requireParticipant } from "../members/membership";
import type { Modules } from "../modules";
import { SEARCH_KINDS, SEARCH_MAX_PAGE_SIZE } from "../search/vocabulary";

const searchQuery = z.object({
  q: z.string().max(200),
  /** Comma-separated kinds to list, such as `cases,alerts`; every kind when left out. */
  kinds: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : []))
    .pipe(z.array(z.enum(SEARCH_KINDS))),
  /** Which page of results, from 1. */
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(SEARCH_MAX_PAGE_SIZE).optional(),
});

/** Global search, for Members and Guests; what each finds is up to the access policy. */
export const searchRoutes = (deps: Deps, { search }: Modules) =>
  new Hono<ParticipantEnv>().use(requireParticipant(deps)).get("/", zValidator("query", searchQuery), async (c) => {
    const { q, ...options } = c.req.valid("query");
    return c.json({ results: await search.search(c.get("participant"), q, options) }, 200);
  });
