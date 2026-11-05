import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../deps";
import { type ParticipantEnv, requireParticipant } from "../members/membership";
import type { Modules } from "../modules";
import { ItemNotFound } from "../observables/observables";

const idParam = z.object({ id: z.string().min(1).max(100) });

/**
 * An Observable's or Asset's page, for Members and Guests; what each sees of it is up to the access
 * policy, and one they may not see is not found.
 */
const itemRoutes = <Store extends Modules["observables"] | Modules["assets"]>(deps: Deps, store: Store) =>
  new Hono<ParticipantEnv>().use(requireParticipant(deps)).get("/:id", zValidator("param", idParam), async (c) => {
    try {
      const item = (await store.detail(c.get("participant"), c.req.valid("param").id)) as Awaited<ReturnType<Store["detail"]>>;
      return c.json({ item }, 200);
    } catch (e) {
      if (e instanceof ItemNotFound) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

export const observableRoutes = (deps: Deps, { observables }: Modules) => itemRoutes(deps, observables);
export const assetRoutes = (deps: Deps, { assets }: Modules) => itemRoutes(deps, assets);
