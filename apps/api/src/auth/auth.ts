import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import type { Db } from "../db/client";
import { OPERATOR_ROLE, ac, orgRoles, serviceAc, serviceRoles } from "./roles";

export type AuthDeps = {
  db: Db;
  baseUrl: string;
  secret: string;
};

export function createAuth({ db, baseUrl, secret }: AuthDeps) {
  return betterAuth({
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
    ],
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
