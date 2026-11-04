import { deriveSAMLIdentityProviderEntityID, type SAMLConfig, type SSOUserResolution, type SSOUserResolutionInput } from "@better-auth/sso";
import { and, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { NotPermitted, organizationPolicy } from "../access/policy";
import { recordOrgAudit } from "../audit/org-audit-log";
import type { OrgRole } from "../auth/roles";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { account, invitation, member, organization, session, ssoProvider, user } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import { publish } from "../realtime/signals";

/**
 * SAML single sign-on, one connection per Organization. Admins configure it here (each change in
 * the Organization Audit Log); Better Auth's `sso` plugin runs the sign-in itself, and asks
 * `ssoUserResolver` who each verified identity is: an existing Member of the Organization, or a new
 * Analyst when the Organization allows it. Nobody else gets in.
 */

export class InvalidSsoConfig extends Error {}

export class SsoDomainTaken extends Error {
  constructor() {
    super("Another Organization already signs in with SSO for this email domain");
  }
}

export class SsoNotEnabled extends Error {
  constructor() {
    super("SSO isn't enabled");
  }
}

/** The identity provider, from its metadata XML, or entered by hand. */
export type IdpInput = { metadataXml: string } | { entityId: string; ssoUrl: string; certificate: string };

export type SsoInput = {
  /** The email domain whose people sign in with SSO, e.g. "acme.com". */
  domain: string;
  /** Left out to keep the identity provider already configured. */
  idp?: IdpInput;
  /** Make an Analyst of someone the identity provider vouches for who isn't a Member yet. */
  provisionAnalysts: boolean;
};

/** The plugin's id for an Organization's connection; it names the connection in Argus's SAML URLs. */
export const ssoProviderIdOf = (organizationId: string) => `org-${organizationId}`;

/** What an Admin gives their identity provider: Argus's entity ID and where assertions go. */
export const serviceProviderOf = (baseUrl: string, providerId: string) => {
  const metadataUrl = `${baseUrl}/api/auth/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`;
  return { entityId: metadataUrl, acsUrl: `${baseUrl}/api/auth/sso/saml2/sp/acs/${providerId}`, metadataUrl };
};

const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_ADDRESS_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

/** Reads the DER length at `at` (after the tag): its value and where the contents start. */
function derLength(der: Uint8Array, at: number) {
  const first = der[at] ?? 0;
  if (first < 0x80) return { length: first, start: at + 1 };
  const bytes = first & 0x7f;
  if (bytes < 1 || bytes > 4) return null;
  let length = 0;
  for (let i = 1; i <= bytes; i++) length = length * 256 + (der[at + i] ?? 0);
  return { length, start: at + 1 + bytes };
}

/**
 * A PEM certificate, from PEM or bare base64. It must be one DER certificate: a SEQUENCE spanning
 * the whole, starting with the signed SEQUENCE. The identity provider's signatures are verified with
 * it at each sign-in. Throws `InvalidSsoConfig`.
 */
function checkCertificate(input: string) {
  const body = input.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  } catch {
    der = new Uint8Array();
  }
  const outer = der[0] === 0x30 ? derLength(der, 1) : null;
  const signed = outer && der[outer.start] === 0x30 ? derLength(der, outer.start + 1) : null;
  if (!outer || !signed || outer.start + outer.length !== der.length || signed.start + signed.length > der.length) {
    throw new InvalidSsoConfig("The signing certificate isn't a valid X.509 certificate");
  }
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}

function checkUrl(input: string) {
  try {
    const url = new URL(input);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {}
  throw new InvalidSsoConfig("The SSO URL must be an http(s) URL");
}

/** The plugin's SAML configuration for an Organization's connection. Throws `InvalidSsoConfig`. */
export function samlConfigOf(baseUrl: string, providerId: string, idp: IdpInput): SAMLConfig {
  const sp = serviceProviderOf(baseUrl, providerId);
  const common = {
    issuer: sp.entityId,
    // Unsigned assertions are refused.
    wantAssertionsSigned: true,
    identifierFormat: EMAIL_ADDRESS_FORMAT,
    mapping: { email: "email", name: "displayName", firstName: "givenName", lastName: "surname" },
  };
  let config: SAMLConfig;
  if ("metadataXml" in idp) {
    config = { ...common, entryPoint: "", idpMetadata: { metadata: idp.metadataXml.trim() } };
  } else {
    const entryPoint = checkUrl(idp.ssoUrl);
    const cert = checkCertificate(idp.certificate);
    if (!idp.entityId.trim()) throw new InvalidSsoConfig("The identity provider's entity ID is required");
    config = { ...common, entryPoint, cert, idpMetadata: { entityID: idp.entityId.trim(), cert } };
  }
  try {
    if (!deriveSAMLIdentityProviderEntityID(config)) throw new Error("No entity ID");
  } catch {
    throw new InvalidSsoConfig("The identity provider's metadata can't be read");
  }
  return config;
}

/** The identity provider's entity ID, and where people are sent to sign in when it was entered by hand. */
const idpOf = (config: SAMLConfig) => ({
  entityId: deriveSAMLIdentityProviderEntityID(config),
  ssoUrl: config.entryPoint || null,
});

/** "acme.com · https://idp.example/entity · provisions Analysts", for the Organization Audit Log. */
const summaryOf = (domain: string, config: SAMLConfig, provisionAnalysts: boolean) =>
  [domain, idpOf(config).entityId, provisionAnalysts ? "provisions Analysts" : "Members only"].join(" · ");

/** Ends `organizationId`'s Members' sessions started with SSO. Joins `tx`. */
async function endSsoSessions(tx: Tx, organizationId: string) {
  const members = tx.select({ userId: member.userId }).from(member).where(eq(member.organizationId, organizationId));
  await tx.delete(session).where(and(eq(session.signedInWithSso, true), inArray(session.userId, members)));
}

export function ssoStore({ db, clock, baseUrl }: Pick<Deps, "db" | "clock" | "baseUrl">) {
  const find = (organizationId: string) =>
    db
      .select({ row: ssoProvider, byName: user.name })
      .from(ssoProvider)
      .innerJoin(user, eq(ssoProvider.userId, user.id))
      .where(eq(ssoProvider.organizationId, organizationId))
      .then((rows) => rows[0] ?? null);

  const auditBy = (me: Membership) => ({
    organizationId: me.organizationId,
    occurredAt: clock.now(),
    actor: { type: "member" as const, id: me.userId, name: me.name },
    category: "sso" as const,
  });

  return {
    /** Whether SSO is enabled; for Admins, how it is configured and what to give the identity provider. */
    async get(me: Membership) {
      const found = await find(me.organizationId);
      const providerId = ssoProviderIdOf(me.organizationId);
      if (!organizationPolicy.canManageSso(me)) return { enabled: !!found, config: null };
      const config = found && {
        domain: found.row.domain,
        provisionAnalysts: found.row.provisionAnalysts,
        idp: idpOf(JSON.parse(found.row.samlConfig ?? "{}") as SAMLConfig),
        updatedBy: { id: found.row.userId, name: found.byName },
        updatedAt: found.row.updatedAt.toISOString(),
      };
      return { enabled: !!found, config, serviceProvider: serviceProviderOf(baseUrl, providerId) };
    },

    /**
     * Enables SSO for `me`'s Organization, or changes its configuration (keeping its identity
     * provider unless another is given). Admins only. Throws
     * `InvalidSsoConfig` and `SsoDomainTaken`. A new identity provider unlinks everyone's SSO
     * identities; each is linked again, by email, at their next sign-in.
     */
    async configure(me: Membership, input: SsoInput) {
      if (!organizationPolicy.canManageSso(me)) throw new NotPermitted();
      const domain = input.domain.trim().toLowerCase().replace(/^@/, "");
      if (!DOMAIN.test(domain)) throw new InvalidSsoConfig("Enter an email domain, like example.com");
      const providerId = ssoProviderIdOf(me.organizationId);
      const given = input.idp && samlConfigOf(baseUrl, providerId, input.idp);
      const now = clock.now();
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(ssoProvider).where(eq(ssoProvider.organizationId, me.organizationId)).for("update");
        const previous = current && (JSON.parse(current.samlConfig ?? "{}") as SAMLConfig);
        const config = given ?? previous;
        if (!config) throw new InvalidSsoConfig("Give the identity provider's metadata, or its entity ID, sign-in URL and certificate");
        const [taken] = await tx
          .select({ id: ssoProvider.id })
          .from(ssoProvider)
          .where(and(eq(ssoProvider.domain, domain), ne(ssoProvider.organizationId, me.organizationId)));
        if (taken) throw new SsoDomainTaken();
        const values = {
          issuer: config.issuer,
          samlConfig: JSON.stringify(config),
          domain,
          provisionAnalysts: input.provisionAnalysts,
          userId: me.userId,
          updatedAt: now,
        };
        const after = summaryOf(domain, config, input.provisionAnalysts);
        if (!current) {
          await tx.insert(ssoProvider).values({ id: secureId(), providerId, organizationId: me.organizationId, ...values });
          await recordOrgAudit(tx, { ...auditBy(me), action: "sso.enabled", after });
          return;
        }
        if (idpOf(previous!).entityId !== idpOf(config).entityId) {
          await tx.delete(account).where(eq(account.providerId, providerId));
        }
        await tx.update(ssoProvider).set(values).where(eq(ssoProvider.id, current.id));
        await recordOrgAudit(tx, {
          ...auditBy(me),
          action: "sso.changed",
          before: summaryOf(current.domain, previous!, current.provisionAnalysts),
          after,
        });
      });
      return this.get(me);
    },

    /** Turns SSO off: its sign-ins stop, and sessions started with it end. Admins only. Throws `SsoNotEnabled`. */
    async disable(me: Membership) {
      if (!organizationPolicy.canManageSso(me)) throw new NotPermitted();
      const providerId = ssoProviderIdOf(me.organizationId);
      await db.transaction(async (tx) => {
        const [removed] = await tx.delete(ssoProvider).where(eq(ssoProvider.organizationId, me.organizationId)).returning();
        if (!removed) throw new SsoNotEnabled();
        await tx.delete(account).where(eq(account.providerId, providerId));
        await endSsoSessions(tx, me.organizationId);
        await recordOrgAudit(tx, {
          ...auditBy(me),
          action: "sso.disabled",
          before: summaryOf(removed.domain, JSON.parse(removed.samlConfig ?? "{}") as SAMLConfig, removed.provisionAnalysts),
        });
      });
      return this.get(me);
    },
  };
}

export type SsoStore = ReturnType<typeof ssoStore>;

const reject = (code: string, message: string): SSOUserResolution => ({ action: "reject", code, message });

/**
 * Decides who a verified SAML identity is, for the `sso` plugin: the Member of the connection's
 * Organization with that email; else someone with a pending invitation, who joins with the invited
 * role; else, if the Organization provisions Analysts and the email is in its domain, a new Analyst.
 * Guests, Operators and Members of other Organizations are refused.
 *
 * It runs inside the plugin's sign-in transaction, but provisions in its own, so the new Member is
 * there when the session starts. Should the sign-in then fail, they are linked at the next one.
 */
export const ssoUserResolver =
  ({ db, clock }: { db: Db; clock: Clock }) =>
  async (input: SSOUserResolutionInput): Promise<SSOUserResolution> => {
    if (input.protocol !== "saml") return reject("sso_not_configured", "Only SAML is supported");
    const [provider] = await db
      .select({ organizationId: ssoProvider.organizationId, domain: ssoProvider.domain, provisionAnalysts: ssoProvider.provisionAnalysts })
      .from(ssoProvider)
      .innerJoin(organization, eq(ssoProvider.organizationId, organization.id))
      .where(and(eq(ssoProvider.providerId, input.providerId), isNull(organization.deletedAt)));
    const organizationId = provider?.organizationId;
    if (!provider || !organizationId) return reject("sso_not_configured", "SSO isn't enabled for this Organization");
    const email = input.providerUser.email.trim().toLowerCase();

    const existing = await db.query.user.findFirst({ where: eq(user.email, email) });
    if (existing) {
      const [membership] = await db
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.userId, existing.id), eq(member.organizationId, organizationId)));
      if (!membership) return reject("not_a_member", "This account isn't a Member of the Organization");
      return { action: "link", userId: existing.id, profile: "preserve" };
    }

    const now = clock.now();
    const [invited] = await db
      .select({ id: invitation.id, role: invitation.role })
      .from(invitation)
      .where(
        and(eq(invitation.organizationId, organizationId), eq(invitation.email, email), eq(invitation.status, "pending"), gt(invitation.expiresAt, now)),
      );
    if (!invited) {
      if (!provider.provisionAnalysts) return reject("not_a_member", "You aren't a Member yet. Ask an Admin for an invite.");
      if (!email.endsWith(`@${provider.domain}`)) return reject("email_domain_mismatch", `Only ${provider.domain} addresses can join with SSO`);
    }

    const name = input.providerUser.name.trim() || email;
    const role = (invited?.role ?? "analyst") as OrgRole;
    const userId = secureId();
    await db.transaction(async (tx) => {
      if (invited) {
        const [accepted] = await tx
          .update(invitation)
          .set({ status: "accepted" })
          .where(and(eq(invitation.id, invited.id), eq(invitation.status, "pending")))
          .returning({ id: invitation.id });
        if (!accepted) throw new Error("The invitation was revoked or accepted meanwhile");
      }
      await tx.insert(user).values({ id: userId, name, email, emailVerified: true, role: "user", createdAt: now, updatedAt: now });
      await tx.insert(member).values({ id: secureId(), organizationId, userId, role, createdAt: now });
      await recordOrgAudit(tx, {
        organizationId,
        occurredAt: now,
        actor: { type: "member", id: userId, name },
        category: "members",
        action: "member.joined",
        target: email,
        after: role,
      });
      await publish(tx, { kind: "members", organizationId });
    });
    return { action: "link", userId, profile: "preserve" };
  };
