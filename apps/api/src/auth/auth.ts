import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin, organization, twoFactor } from "better-auth/plugins";
import type { Db } from "../db/client";
import { OPERATOR_ROLE, ac, orgRoles, serviceAc, serviceRoles } from "./roles";
import { TOTP_ENROLLMENT_PATHS, TOTP_ENROLLMENT_REQUIRED, totpEnrollmentPending } from "./totp-enrollment";

export type AuthDeps = {
  db: Db;
  baseUrl: string;
  secret: string;
};

export function createAuth({ db, baseUrl, secret }: AuthDeps) {
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
      }),
      twoFactor({ issuer: "Argus" }),
      passkey({ rpName: "Argus", origin: baseUrl }),
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
        if (TOTP_ENROLLMENT_PATHS.has(ctx.path)) return;
        const session = await getSessionFromCtx(ctx);
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
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
