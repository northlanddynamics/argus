import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../deps";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";
import { InvalidDomain, InvalidUrl } from "../virustotal/domain-url-lookups";

const domainBody = z.object({ domain: z.string().trim().min(1).max(320) });
const urlBody = z.object({ url: z.string().trim().min(1).max(4096) });

/**
 * Domain lookups through VirusTotal (ADR 0012), for Members only, each with their own key: `GET
 * /?domain=…` (a domain, or an email address, looked up by its domain) answers from the
 * Organization's cache, fetching when nothing fresh is cached, and `POST /refresh` with `{ domain }`
 * always fetches.
 */
export const domainLookupRoutes = (deps: Deps, { domainUrlLookups }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", zValidator("query", domainBody), async (c) => {
      try {
        return c.json({ lookup: await domainUrlLookups.lookupDomain(c.get("membership"), c.req.valid("query").domain) }, 200);
      } catch (e) {
        if (e instanceof InvalidDomain) return c.json({ error: e.message }, 422);
        throw e;
      }
    })
    .post("/refresh", zValidator("json", domainBody), async (c) => {
      try {
        return c.json({ lookup: await domainUrlLookups.lookupDomain(c.get("membership"), c.req.valid("json").domain, { refresh: true }) }, 200);
      } catch (e) {
        if (e instanceof InvalidDomain) return c.json({ error: e.message }, 422);
        throw e;
      }
    });

/** URL lookups through VirusTotal (ADR 0012), as domain lookups: `GET /?url=…` and `POST /refresh` with `{ url }`. */
export const urlLookupRoutes = (deps: Deps, { domainUrlLookups }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", zValidator("query", urlBody), async (c) => {
      try {
        return c.json({ lookup: await domainUrlLookups.lookupUrl(c.get("membership"), c.req.valid("query").url) }, 200);
      } catch (e) {
        if (e instanceof InvalidUrl) return c.json({ error: e.message }, 422);
        throw e;
      }
    })
    .post("/refresh", zValidator("json", urlBody), async (c) => {
      try {
        return c.json({ lookup: await domainUrlLookups.lookupUrl(c.get("membership"), c.req.valid("json").url, { refresh: true }) }, 200);
      } catch (e) {
        if (e instanceof InvalidUrl) return c.json({ error: e.message }, 422);
        throw e;
      }
    });
