import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { NotPermitted } from "../access/policy";
import type { Deps } from "../deps";
import { type CaseWorkEnv, membersOnly, type ParticipantEnv, requireParticipant } from "../members/membership";
import type { Modules } from "../modules";
import { ItemNotFound } from "../observables/observables";

const idParam = z.object({ id: z.string().min(1).max(100) });

const notPermitted = { error: "Not permitted" } as const;

/**
 * An Observable's or Asset's page, for Members and Guests; what each sees of it is up to the access
 * policy, and one they may not see is not found. Admins put it on the Ignored list (`PUT /:id/ignored`)
 * and take it off again (`DELETE /:id/ignored`).
 */
const itemRoutes = <Store extends Modules["observables"] | Modules["assets"]>(deps: Deps, store: Store) => {
  const setIgnored = (ignored: boolean) => async (c: Context<CaseWorkEnv>) => {
    try {
      const changed = await store.setIgnored(c.get("membership"), c.req.param("id") ?? "", ignored);
      return c.json({ changed }, 200);
    } catch (e) {
      if (e instanceof NotPermitted) return c.json(notPermitted, 403);
      if (e instanceof ItemNotFound) return c.json({ error: e.message }, 404);
      throw e;
    }
  };
  return new Hono<ParticipantEnv>()
    .use(requireParticipant(deps))
    .get("/:id", zValidator("param", idParam), async (c) => {
      try {
        const item = (await store.open(c.get("participant"), c.req.valid("param").id)) as Awaited<ReturnType<Store["detail"]>>;
        return c.json({ item }, 200);
      } catch (e) {
        if (e instanceof ItemNotFound) return c.json({ error: e.message }, 404);
        throw e;
      }
    })
    .put("/:id/ignored", zValidator("param", idParam), membersOnly, setIgnored(true))
    .delete("/:id/ignored", zValidator("param", idParam), membersOnly, setIgnored(false));
};

export const observableRoutes = (deps: Deps, { observables }: Modules) => itemRoutes(deps, observables);
/** A host's Enrichment is fetched from Falcon again when a Member asks (`POST /:id/enrichment`, ADR 0009). */
export const assetRoutes = (deps: Deps, { assets }: Modules) =>
  itemRoutes(deps, assets).post("/:id/enrichment", zValidator("param", idParam), membersOnly, async (c) => {
    try {
      return c.json({ item: await assets.open(c.get("participant"), c.req.valid("param").id, { refresh: true }) }, 200);
    } catch (e) {
      if (e instanceof ItemNotFound) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

/** The Organization's Ignored list, for Members. */
export const ignoredObservableRoutes = (deps: Deps, { ignoredObservables }: Modules) =>
  new Hono<ParticipantEnv>()
    .use(requireParticipant(deps))
    .get("/", async (c) => {
      try {
        return c.json({ ignored: await ignoredObservables.list(c.get("participant")) }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        throw e;
      }
    });
