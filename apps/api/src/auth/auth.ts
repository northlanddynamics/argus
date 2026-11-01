import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin, magicLink, organization, twoFactor } from "better-auth/plugins";
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import { isGuestAccount, mayUseMagicLink, startGuestSession } from "../guests/guest-sessions";
import type { Mailer } from "../mail";
import { OPERATOR_ROLE, ac, orgRoles, serviceAc, serviceRoles } from "./roles";
import { TOTP_ENROLLMENT_PATHS, TOTP_ENROLLMENT_REQUIRED, totpEnrollmentPending } from "./totp-enrollment";

/** The organization plugin's endpoints that only read; every other one is refused. */
const ORGANIZATION_READ_PATHS = new Set([
  "/organization/list",
  "/organization/set-active",
  "/organization/get-full-organization",
  "/organization/get-active-member",
  "/organization/get-active-member-role",
  "/organization/list-members",
  "/organization/has-permission",
]);

/** The only Better Auth endpoints a Guest's session may call: Guests have no password, passkey or TOTP. */
const GUEST_PATHS = new Set(["/get-session", "/sign-out", "/sign-in/magic-link", "/magic-link/verify"]);

/** How long a magic link works for. */
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;

export type AuthDeps = {
  db: Db;
  baseUrl: string;
  secret: string;
  /** Delivers magic links. */
  mailer: Mailer;
  /** Decides whether a Guest grant still counts when a magic link is asked for. */
  clock: Clock;
};

export function createAuth({ db, baseUrl, secret, mailer, clock }: AuthDeps) {
  return betterAuth({
    appName: "Argus",
    baseURL: baseUrl,
    basePath: "/api/auth",
    secret,
    database: drizzleAdapter(db, { provider: "pg" }),
    // No self-serve sign-up: accounts are created from invitations only.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    plugins: [
      admin({ ac: serviceAc, roles: serviceRoles, defaultRole: "user", adminRoles: [OPERATOR_ROLE] }),
      organization({
        ac,
        roles: orgRoles,
        creatorRole: "owner",
        allowUserToCreateOrganization: false,
        // Organizations are never hard-deleted (ADR 0003); deletion sets this.
        schema: {
          organization: {
            additionalFields: { deletedAt: { type: "date", required: false, input: false } },
          },
        },
      }),
      twoFactor({ issuer: "Argus" }),
      passkey({ rpName: "Argus", origin: baseUrl }),
      // Guests sign in with an emailed link. Accounts come only from Guest invitations.
      magicLink({
        disableSignUp: true,
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          // Only Guests holding a grant get a link; anyone else gets the same answer and no email.
          if (!(await mayUseMagicLink(db, email, clock.now()))) return;
          await mailer.send({
            to: email,
            subject: "Your Argus sign-in link",
            text: [
              "Sign in to Argus with this link:",
              "",
              url,
              "",
              `It works once, for ${MAGIC_LINK_TTL_SECONDS / 60} minutes. Your session then lasts about 12 hours.`,
              "If you didn't ask for it, ignore this email.",
            ].join("\n"),
          });
        },
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // TOTP is mandatory for Members: it can't be turned off, and no device is trusted to skip it.
        if (ctx.path === "/two-factor/disable") {
          throw new APIError("FORBIDDEN", { message: "Two-factor authentication cannot be turned off" });
        }
        if (ctx.path.startsWith("/two-factor/verify-") && ctx.body?.trustDevice) {
          throw new APIError("BAD_REQUEST", { message: "Trusted devices are not supported" });
        }
        // Membership changes go through Argus so each one lands in the Organization Audit Log.
        if (ctx.path.startsWith("/organization/") && !ORGANIZATION_READ_PATHS.has(ctx.path)) {
          throw new APIError("FORBIDDEN", { message: "Manage Members in Argus settings" });
        }
        if (TOTP_ENROLLMENT_PATHS.has(ctx.path) && GUEST_PATHS.has(ctx.path)) return;
        const session = await getSessionFromCtx(ctx);
        if (session && !GUEST_PATHS.has(ctx.path) && (await isGuestAccount(db, session.user))) {
          throw new APIError("FORBIDDEN", { message: "Guests sign in with an email link only" });
        }
        if (TOTP_ENROLLMENT_PATHS.has(ctx.path)) return;
        if (session && totpEnrollmentPending(session)) {
          throw new APIError("FORBIDDEN", {
            message: "Set up two-factor authentication to continue",
            code: TOTP_ENROLLMENT_REQUIRED,
          });
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // A Member works in the one Organization they belong to.
          before: async (session) => {
            const membership = await db.query.member.findFirst({
              where: (m, { eq }) => eq(m.userId, session.userId),
            });
            return { data: { ...session, activeOrganizationId: membership?.organizationId ?? null } };
          },
          // A Guest's session is timed by Argus from the moment it starts.
          after: async (session) => {
            const account = await db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, session.userId) });
            if (account && (await isGuestAccount(db, account))) {
              await startGuestSession(db, clock.now(), { sessionId: session.id, userId: session.userId });
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
