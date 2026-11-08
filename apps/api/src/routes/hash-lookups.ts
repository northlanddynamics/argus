import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../deps";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";
import { InvalidHash, KeyRefused } from "../virustotal/hash-lookups";

const hashBody = z.object({ hash: z.string().trim().min(1).max(100) });
const keyBody = z.object({ apiKey: z.string().trim().min(16).max(200) });

/**
 * File lookups by hash through VirusTotal (ADR 0011), for Members only, each with their own key:
 * `GET /?hash=…` answers from the Organization's cache, fetching when nothing fresh is cached, and
 * `POST /refresh` with `{ hash }` always fetches.
 */
export const hashLookupRoutes = (deps: Deps, { hashLookups }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", zValidator("query", hashBody), async (c) => {
      try {
        return c.json({ lookup: await hashLookups.lookup(c.get("membership"), c.req.valid("query").hash) }, 200);
      } catch (e) {
        if (e instanceof InvalidHash) return c.json({ error: e.message }, 422);
        throw e;
      }
    })
    .post("/refresh", zValidator("json", hashBody), async (c) => {
      try {
        return c.json({ lookup: await hashLookups.lookup(c.get("membership"), c.req.valid("json").hash, { refresh: true }) }, 200);
      } catch (e) {
        if (e instanceof InvalidHash) return c.json({ error: e.message }, 422);
        throw e;
      }
    });

/**
 * The signed-in Member's own VirusTotal API key (ADR 0011): `GET /` says whether one is set (its
 * last four characters, never the key), `PUT /` with `{ apiKey }` checks and sets or replaces it,
 * and `DELETE /` removes it. No one else, Admins included, sees or changes it.
 */
export const virustotalKeyRoutes = (deps: Deps, { hashLookups }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", async (c) => c.json({ key: await hashLookups.key(c.get("membership")) }, 200))
    .put("/", zValidator("json", keyBody), async (c) => {
      try {
        return c.json({ key: await hashLookups.setKey(c.get("membership"), c.req.valid("json").apiKey) }, 200);
      } catch (e) {
        if (e instanceof KeyRefused) return c.json({ error: e.message }, 422);
        throw e;
      }
    })
    .delete("/", async (c) => {
      if (!(await hashLookups.removeKey(c.get("membership")))) return c.json({ error: "You have no VirusTotal API key set" }, 404);
      return c.json({ key: null }, 200);
    });
