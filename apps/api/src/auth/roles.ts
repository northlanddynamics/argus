import { createAccessControl } from "better-auth/plugins/access";
import { adminAc as serviceAdminAc, defaultStatements as serviceStatements, userAc } from "better-auth/plugins/admin/access";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";

/** Organization roles: Owner, Admin and Analyst (see GLOSSARY.md). */
export const ac = createAccessControl(defaultStatements);

export const orgRoles = {
  owner: ac.newRole(ownerAc.statements),
  admin: ac.newRole(adminAc.statements),
  analyst: ac.newRole(memberAc.statements),
};

export type OrgRole = keyof typeof orgRoles;

/** The Better Auth `admin` plugin role that marks an Operator. */
export const OPERATOR_ROLE = "operator";

/** Service-level roles for the `admin` plugin: every person is a `user`, Operators are `operator`. */
export const serviceAc = createAccessControl(serviceStatements);

export const serviceRoles = {
  user: serviceAc.newRole(userAc.statements),
  [OPERATOR_ROLE]: serviceAc.newRole(serviceAdminAc.statements),
};
