import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { NotPermitted } from "../access/policy";
import { FALCON_CLOUDS } from "../alerts/vocabulary";
import type { Deps } from "../deps";
import {
  IntegrationHoldsResponseActions,
  IntegrationNameTaken,
  type NewIntegration,
  IntegrationNotFound,
  InvalidDefaults,
  NotSupportedByProvider,
  OneIpinfoIntegration,
  ToolUnavailable,
  UnknownDestinationList,
  WrongCredentials,
} from "../integrations/integrations";
import { SEVERITIES } from "../cases/vocabulary";
import { FALCON_IOC_PLATFORMS } from "../response-actions/vocabulary";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";

/** What a Falcon custom IOC is sent with besides its action (ADR 0008). */
const defaultsBody = z.object({
  severity: z.enum(["case", ...SEVERITIES]),
  platforms: z.array(z.enum(FALCON_IOC_PLATFORMS)).min(1, "Choose at least one platform"),
  internal: z.boolean(),
});
const credentialsBody = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(500),
});
const crowdstrikeBody = credentialsBody.extend({
  provider: z.literal("crowdstrike").default("crowdstrike"),
  name: z.string().trim().min(1).max(80),
  cloud: z.enum(FALCON_CLOUDS),
  /** Off unless asked for: an Integration only reads from Falcon until an Admin allows write-back. */
  writeBack: z.boolean().default(false),
  /** Off unless asked for: no Response Actions are taken through it until an Admin turns them on. */
  responseActions: z.boolean().default(false),
  /** What its Response Actions are sent with; severity from the Case, every platform, not Internal, if left out. */
  responseActionDefaults: defaultsBody.optional(),
});
/** A Mimecast API 2.0 application: no cloud, no Alert stream and no write-back to choose. */
const mimecastBody = z.strictObject({
  ...credentialsBody.shape,
  provider: z.literal("mimecast"),
  name: z.string().trim().min(1).max(80),
  responseActions: z.boolean().default(false),
  responseActionDefaults: defaultsBody.optional(),
});
/** A Cisco Umbrella API key and secret (ADR 0014): no cloud, no Alert stream and no write-back to choose. */
const umbrellaBody = z.strictObject({
  ...credentialsBody.shape,
  provider: z.literal("umbrella"),
  name: z.string().trim().min(1).max(80),
  responseActions: z.boolean().default(false),
  responseActionDefaults: defaultsBody.optional(),
});
/** An IPinfo API token (ADR 0010): it only looks IPs up, so there is nothing else to choose. */
const tokenBody = z.strictObject({ token: z.string().trim().min(8).max(200) });
const ipinfoBody = z.strictObject({
  ...tokenBody.shape,
  provider: z.literal("ipinfo"),
  name: z.string().trim().min(1).max(80),
});
const createBody = z.union([crowdstrikeBody, mimecastBody, umbrellaBody, ipinfoBody]);
const destinationListBody = z.object({ destinationListId: z.number().int().positive() });
const rotateBody = z.union([credentialsBody, tokenBody]);
const enabledBody = z.object({ enabled: z.boolean() });


const notPermitted = { error: "Not permitted" } as const;

/**
 * Integrations (CrowdStrike, Mimecast, Cisco Umbrella or IPinfo): every Member sees them and their
 * health; Admins add, rotate, pause, resume and delete them and set their write-back, Response
 * Actions, Response Action defaults, Host containment and, for Umbrella, the destination list it adds
 * domains to.
 */
export const integrationRoutes = (deps: Deps, { integrations }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", async (c) => c.json({ integrations: await integrations.list(c.get("membership")) }, 200))
    .post("/", zValidator("json", createBody), async (c) => {
      const body = c.req.valid("json");
      try {
        let input: NewIntegration;
        if (body.provider === "ipinfo") {
          const { token, ...rest } = body;
          input = { ...rest, credentials: { token } };
        } else {
          const { clientId, clientSecret, ...rest } = body;
          input = { ...rest, credentials: { clientId, clientSecret } };
        }
        const created = await integrations.create(c.get("membership"), input);
        return c.json({ integration: created }, 201);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNameTaken) return c.json({ error: e.message }, 409);
        if (e instanceof OneIpinfoIntegration) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .put("/:id/credentials", zValidator("json", rotateBody), async (c) => {
      try {
        await integrations.rotateCredentials(c.get("membership"), c.req.param("id"), c.req.valid("json"));
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof WrongCredentials) return c.json({ error: e.message }, 422);
        throw e;
      }
    })
    .post("/:id/pause", async (c) => {
      try {
        await integrations.setPaused(c.get("membership"), c.req.param("id"), true);
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        throw e;
      }
    })
    .post("/:id/resume", async (c) => {
      try {
        await integrations.setPaused(c.get("membership"), c.req.param("id"), false);
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        throw e;
      }
    })
    .put("/:id/write-back", zValidator("json", enabledBody), async (c) => {
      try {
        await integrations.setWriteBack(c.get("membership"), c.req.param("id"), c.req.valid("json").enabled);
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof NotSupportedByProvider) return c.json({ error: e.message }, 422);
        throw e;
      }
    })
    .put("/:id/response-actions", zValidator("json", enabledBody), async (c) => {
      try {
        await integrations.setResponseActions(c.get("membership"), c.req.param("id"), c.req.valid("json").enabled);
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof NotSupportedByProvider) return c.json({ error: e.message }, 422);
        throw e;
      }
    })
    .put("/:id/host-containment", zValidator("json", enabledBody), async (c) => {
      try {
        await integrations.setHostContainment(c.get("membership"), c.req.param("id"), c.req.valid("json").enabled);
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof NotSupportedByProvider) return c.json({ error: e.message }, 422);
        throw e;
      }
    })
    .get("/:id/destination-lists", async (c) => {
      try {
        return c.json({ destinationLists: await integrations.destinationLists(c.get("membership"), c.req.param("id")) }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof NotSupportedByProvider) return c.json({ error: e.message }, 422);
        if (e instanceof ToolUnavailable) return c.json({ error: e.message }, 502);
        throw e;
      }
    })
    .put("/:id/destination-list", zValidator("json", destinationListBody), async (c) => {
      try {
        const chosen = await integrations.setDestinationList(c.get("membership"), c.req.param("id"), c.req.valid("json").destinationListId);
        return c.json({ destinationList: chosen }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof NotSupportedByProvider) return c.json({ error: e.message }, 422);
        if (e instanceof UnknownDestinationList) return c.json({ error: e.message }, 422);
        if (e instanceof ToolUnavailable) return c.json({ error: e.message }, 502);
        throw e;
      }
    })
    .put("/:id/response-action-defaults", zValidator("json", defaultsBody), async (c) => {
      try {
        await integrations.setResponseActionDefaults(c.get("membership"), c.req.param("id"), c.req.valid("json"));
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof NotSupportedByProvider) return c.json({ error: e.message }, 422);
        if (e instanceof InvalidDefaults) return c.json({ error: e.message }, 422);
        throw e;
      }
    })
    .delete("/:id", async (c) => {
      try {
        await integrations.delete(c.get("membership"), c.req.param("id"));
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof IntegrationHoldsResponseActions) return c.json({ error: e.message }, 409);
        throw e;
      }
    });
