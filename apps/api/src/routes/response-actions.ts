import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { NotPermitted } from "../access/policy";
import { CaseClosed, CaseNotFound } from "../cases/cases";
import type { Deps } from "../deps";
import { membersOnly, type ParticipantEnv, requireParticipant } from "../members/membership";
import type { Modules } from "../modules";
import { NotLinked } from "../observables/observables";
import {
  HostNotContainable,
  IgnoredNotConfirmed,
  IntegrationNotEligible,
  NotDismissable,
  NotRemovable,
  NotRetryable,
  ObservableNotAccepted,
  RelyingCasesNotConfirmed,
  ResponseActionNotFound,
} from "../response-actions/response-actions";
import { RESPONSE_ACTION_ACTIONS } from "../response-actions/vocabulary";

const numberParam = z.object({ number: z.coerce.number().int().positive() });
const actionParam = numberParam.extend({ id: z.string().min(1) });

const takeBody = z.object({
  observableId: z.string().min(1),
  integrationId: z.string().min(1),
  /** For Falcon, Detect, or Prevent for hashes only; for Mimecast, Block sender or Block domain, for an email address. */
  action: z.enum(RESPONSE_ACTION_ACTIONS),
  /** Hidden from the Case's Guests. */
  internal: z.boolean().optional(),
  /** Sends it even if it is on the Ignored list. */
  confirmIgnored: z.boolean().default(false),
});

const ids = z.array(z.string().min(1).max(100)).min(1).max(500);
const takeManyBody = z.object({
  observableIds: ids,
  integrationIds: z.array(z.string().min(1).max(100)).min(1).max(50),
  /**
   * One Provider's action, which every Integration chosen must take. Falcon's are Detect, or Prevent,
   * which only hashes take; Mimecast's Block sender or Block domain, which only email addresses take.
   * Observables the Provider doesn't take as asked are skipped.
   */
  action: z.enum(RESPONSE_ACTION_ACTIONS),
  /** Hidden from the Case's Guests. */
  internal: z.boolean().optional(),
  /** Sends those on the Ignored list too; without it, any among them refuses the request. */
  confirmIgnored: z.boolean().default(false),
});

const containBody = z.object({
  assetId: z.string().min(1),
  integrationId: z.string().min(1),
  /** The Falcon device (`aid`) to contain: one recorded on the host, picked when it has several. */
  deviceId: z.string().min(1).max(100),
  /** Hidden from the Case's Guests. */
  internal: z.boolean().optional(),
});
const assetParam = numberParam.extend({ assetId: z.string().min(1) });

const removeBody = z.object({
  /** Removes it even though other Cases' "already present" records rely on it. */
  confirmRelying: z.boolean().default(false),
});

/** The refusal of a send that includes Ignored Observables it didn't confirm, naming them. */
const ignoredRefusal = (e: IgnoredNotConfirmed) => ({ error: e.message, ignored: e.observables });

const notFound = { error: "Case not found" } as const;
const guestsRefused = { error: "Guests can't take Response Actions" } as const;

/** The result, or null when the Member can't see the Case. */
const unlessNotFound = <T>(work: Promise<T>) =>
  work.catch((e: unknown) => {
    if (e instanceof CaseNotFound) return null;
    throw e;
  });

/**
 * A Case's Response Actions (ADR 0007): list them (Guests too, without Internal ones or Integration
 * details), take one, take several at once (`/bulk`: one per Observable per Integration, with those
 * a Provider doesn't take skipped and reported), retry a Failed one, remove one the Case created
 * (which deletes it in the tool; refused, naming the Cases that rely on it, unless confirmed), and
 * dismiss an "already present" one (which leaves the tool alone). All but listing are for Members, on
 * a Case that isn't Closed; on a Closed Case Admins may still remove, and retry a failed removal.
 *
 * Containing a host (ADR 0009) is confirmed first: `POST …/assets/:assetId/containment-check` asks
 * Falcon for the host afresh and `GET` reads what came back, which the confirmation shows; then
 * `POST …/response-actions/containment` contains the device picked.
 */
export const responseActionRoutes = (deps: Deps, { responseActions }: Modules) =>
  new Hono<ParticipantEnv>()
    .use(requireParticipant(deps))
    .get("/:number/response-actions", zValidator("param", numberParam), async (c) => {
      const found = await unlessNotFound(responseActions.list(c.get("participant"), c.req.valid("param").number));
      if (!found) return c.json(notFound, 404);
      return c.json(found, 200);
    })
    .post("/:number/response-actions", membersOnly, zValidator("param", numberParam), zValidator("json", takeBody), async (c) => {
      try {
        const taken = await unlessNotFound(responseActions.take(c.get("membership"), c.req.valid("param").number, c.req.valid("json")));
        if (!taken) return c.json(notFound, 404);
        return c.json({ responseAction: taken }, 201);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(guestsRefused, 403);
        if (e instanceof NotLinked) return c.json({ error: e.message }, 404);
        if (e instanceof ObservableNotAccepted || e instanceof IntegrationNotEligible) return c.json({ error: e.message }, 400);
        if (e instanceof IgnoredNotConfirmed) return c.json(ignoredRefusal(e), 409);
        if (e instanceof CaseClosed) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .post("/:number/response-actions/bulk", membersOnly, zValidator("param", numberParam), zValidator("json", takeManyBody), async (c) => {
      try {
        const taken = await unlessNotFound(responseActions.takeMany(c.get("membership"), c.req.valid("param").number, c.req.valid("json")));
        if (!taken) return c.json(notFound, 404);
        return c.json(taken, taken.responseActions.length ? 201 : 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(guestsRefused, 403);
        if (e instanceof NotLinked) return c.json({ error: e.message }, 404);
        if (e instanceof IntegrationNotEligible) return c.json({ error: e.message }, 400);
        if (e instanceof IgnoredNotConfirmed) return c.json(ignoredRefusal(e), 409);
        if (e instanceof CaseClosed) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .post("/:number/response-actions/containment", membersOnly, zValidator("param", numberParam), zValidator("json", containBody), async (c) => {
      try {
        const taken = await unlessNotFound(responseActions.contain(c.get("membership"), c.req.valid("param").number, c.req.valid("json")));
        if (!taken) return c.json(notFound, 404);
        return c.json({ responseAction: taken }, 201);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json({ error: "Guests can't contain hosts" }, 403);
        if (e instanceof NotLinked) return c.json({ error: e.message }, 404);
        if (e instanceof IntegrationNotEligible || e instanceof HostNotContainable) return c.json({ error: e.message }, 400);
        if (e instanceof CaseClosed) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .get("/:number/assets/:assetId/containment-check", membersOnly, zValidator("param", assetParam), async (c) => {
      const { number, assetId } = c.req.valid("param");
      try {
        const check = await unlessNotFound(responseActions.containmentCheck(c.get("membership"), number, assetId));
        if (!check) return c.json(notFound, 404);
        return c.json(check, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json({ error: "Guests can't contain hosts" }, 403);
        if (e instanceof NotLinked) return c.json({ error: e.message }, 404);
        throw e;
      }
    })
    .post("/:number/assets/:assetId/containment-check", membersOnly, zValidator("param", assetParam), async (c) => {
      const { number, assetId } = c.req.valid("param");
      try {
        const check = await unlessNotFound(responseActions.containmentCheck(c.get("membership"), number, assetId, { refresh: true }));
        if (!check) return c.json(notFound, 404);
        return c.json(check, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json({ error: "Guests can't contain hosts" }, 403);
        if (e instanceof NotLinked) return c.json({ error: e.message }, 404);
        throw e;
      }
    })
    .post("/:number/response-actions/:id/retry", membersOnly, zValidator("param", actionParam), async (c) => {
      const { number, id } = c.req.valid("param");
      try {
        const retried = await unlessNotFound(responseActions.retry(c.get("membership"), number, id));
        if (!retried) return c.json(notFound, 404);
        return c.json({ responseAction: retried }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(guestsRefused, 403);
        if (e instanceof ResponseActionNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof NotRetryable || e instanceof CaseClosed) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .post("/:number/response-actions/:id/remove", membersOnly, zValidator("param", actionParam), zValidator("json", removeBody), async (c) => {
      const { number, id } = c.req.valid("param");
      try {
        const removing = await unlessNotFound(responseActions.remove(c.get("membership"), number, id, c.req.valid("json")));
        if (!removing) return c.json(notFound, 404);
        return c.json({ responseAction: removing }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json({ error: "Guests can't remove Response Actions" }, 403);
        if (e instanceof ResponseActionNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof RelyingCasesNotConfirmed) return c.json({ error: e.message, relyingCases: e.cases, otherCases: e.otherCases }, 409);
        if (e instanceof NotRemovable || e instanceof CaseClosed) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .post("/:number/response-actions/:id/dismiss", membersOnly, zValidator("param", actionParam), async (c) => {
      const { number, id } = c.req.valid("param");
      try {
        const dismissed = await unlessNotFound(responseActions.dismiss(c.get("membership"), number, id));
        if (!dismissed) return c.json(notFound, 404);
        return c.json({ responseAction: dismissed }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json({ error: "Guests can't dismiss Response Actions" }, 403);
        if (e instanceof ResponseActionNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof NotDismissable || e instanceof CaseClosed) return c.json({ error: e.message }, 409);
        throw e;
      }
    });
