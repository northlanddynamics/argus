import { eq } from "drizzle-orm";
import { NotPermitted, organizationPolicy } from "../access/policy";
import { recordOrgAudit } from "../audit/org-audit-log";
import { mapboxTokens, user } from "../db/schema";
import type { Deps } from "../deps";
import type { Membership } from "../members/membership";

/**
 * The Organization's Mapbox public token: with it, the places IPinfo gives for an IP are drawn on a
 * map wherever its details are shown. A public (`pk.`) token is meant to be in browsers, so every
 * Member gets it; secret (`sk.`) tokens are refused, since they would be sent to every Member too.
 */

/** Not a Mapbox public token. */
export class InvalidMapboxToken extends Error {
  constructor(secret: boolean) {
    super(secret ? "That is a secret token (sk.…); use a public token (pk.…), which is meant to be used in browsers" : "A Mapbox public token starts with pk.");
  }
}

export class MapboxTokenNotSet extends Error {
  constructor() {
    super("Your Organization has no Mapbox token set");
  }
}

/** A Mapbox public token: "pk.", then two base64url parts separated by a dot. */
const TOKEN = /^pk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Throws `InvalidMapboxToken` unless `token` looks like a Mapbox public token. */
export function checkMapboxToken(token: string) {
  const t = token.trim();
  if (!TOKEN.test(t)) throw new InvalidMapboxToken(t.startsWith("sk.") || t.startsWith("tk."));
  return t;
}

/** "pk.…a1b2", as the Org Audit Log and Settings name a token. */
const hintOf = (token: string) => `pk.…${token.slice(-4)}`;

const actorOf = (me: Membership) => ({ type: "member" as const, id: me.userId, name: me.name });

export function mapboxStore({ db, clock }: Pick<Deps, "db" | "clock">) {
  return {
    /** The token, for any Member to draw maps with; for Admins, also who set it and when. */
    async get(me: Membership) {
      const [row] = await db
        .select({ token: mapboxTokens.token, updatedAt: mapboxTokens.updatedAt, byId: user.id, byName: user.name })
        .from(mapboxTokens)
        .innerJoin(user, eq(mapboxTokens.updatedById, user.id))
        .where(eq(mapboxTokens.organizationId, me.organizationId));
      if (!row) return { token: null, hint: null, updatedBy: null, updatedAt: null };
      const admin = organizationPolicy.canManageMapbox(me);
      return {
        token: row.token,
        hint: hintOf(row.token),
        updatedBy: admin ? { id: row.byId, name: row.byName } : null,
        updatedAt: admin ? row.updatedAt.toISOString() : null,
      };
    },

    /** Sets (or replaces) the token. Admins only. Throws `InvalidMapboxToken`. */
    async set(me: Membership, token: string) {
      if (!organizationPolicy.canManageMapbox(me)) throw new NotPermitted();
      const checked = checkMapboxToken(token);
      const now = clock.now();
      await db.transaction(async (tx) => {
        const [current] = await tx.select({ token: mapboxTokens.token }).from(mapboxTokens).where(eq(mapboxTokens.organizationId, me.organizationId)).for("update");
        const values = { token: checked, updatedById: me.userId, updatedAt: now };
        await tx
          .insert(mapboxTokens)
          .values({ organizationId: me.organizationId, ...values })
          .onConflictDoUpdate({ target: mapboxTokens.organizationId, set: values });
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: now,
          actor: actorOf(me),
          category: "mapbox",
          action: current ? "mapbox.token_changed" : "mapbox.token_set",
          target: "Mapbox token",
          before: current ? hintOf(current.token) : null,
          after: hintOf(checked),
        });
      });
    },

    /** Removes the token, so no maps are drawn. Admins only. Throws `MapboxTokenNotSet`. */
    async remove(me: Membership) {
      if (!organizationPolicy.canManageMapbox(me)) throw new NotPermitted();
      await db.transaction(async (tx) => {
        const [removed] = await tx.delete(mapboxTokens).where(eq(mapboxTokens.organizationId, me.organizationId)).returning({ token: mapboxTokens.token });
        if (!removed) throw new MapboxTokenNotSet();
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: clock.now(),
          actor: actorOf(me),
          category: "mapbox",
          action: "mapbox.token_removed",
          target: "Mapbox token",
          before: hintOf(removed.token),
        });
      });
    },
  };
}

export type MapboxStore = ReturnType<typeof mapboxStore>;
