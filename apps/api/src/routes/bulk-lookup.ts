import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { NotPermitted } from "../access/policy";
import { CaseClosed, CaseNotFound } from "../cases/cases";
import type { Deps } from "../deps";
import { membersOnly, type ParticipantEnv, requireParticipant } from "../members/membership";
import type { Modules } from "../modules";
import { LookupRefused } from "../observables/bulk-lookup";
import { BULK_LOOKUP_MAX_VALUES } from "../observables/extract";
import { InvalidValue } from "../observables/observables";
import { OBSERVABLE_TYPES } from "../observables/vocabulary";

const lookupBody = z.object({ text: z.string() });
const linkBody = z.object({
  case: z.number().int().positive(),
  observables: z
    .array(z.object({ type: z.enum(OBSERVABLE_TYPES), value: z.string().trim().min(1).max(2048) }))
    .min(1)
    .max(BULK_LOOKUP_MAX_VALUES),
});

const guestsRefused = { error: "Guests can't use Bulk Lookup" } as const;

/** Well over the text Bulk Lookup reads, so a larger body is refused before it is read. */
const MAX_BODY = 1024 * 1024;

/**
 * Bulk Lookup, for Members only: `POST /` with free text returns every Observable in it, known or
 * not; `POST /link` links chosen ones to a Case as hand links.
 */
export const bulkLookupRoutes = (deps: Deps, { bulkLookup }: Modules) =>
  new Hono<ParticipantEnv>()
    .use(requireParticipant(deps))
    .use(bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "The text is over 100 KB. Split it and look up each part." }, 413) }))
    .post("/", membersOnly, zValidator("json", lookupBody), async (c) => {
      try {
        return c.json({ observables: await bulkLookup.lookup(c.get("membership"), c.req.valid("json").text) }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(guestsRefused, 403);
        if (e instanceof LookupRefused) return c.json({ error: e.message }, 413);
        throw e;
      }
    })
    .post("/link", membersOnly, zValidator("json", linkBody), async (c) => {
      const { case: number, observables } = c.req.valid("json");
      try {
        return c.json(await bulkLookup.link(c.get("membership"), number, observables), 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(guestsRefused, 403);
        if (e instanceof CaseNotFound) return c.json({ error: "Case not found" }, 404);
        if (e instanceof CaseClosed) return c.json({ error: e.message }, 409);
        if (e instanceof InvalidValue) return c.json({ error: e.message }, 400);
        throw e;
      }
    });
