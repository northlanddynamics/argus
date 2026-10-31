import { caseRoleStore } from "./case-roles/case-roles";
import { caseStore } from "./cases/cases";
import type { Deps } from "./deps";
import { invitationStore } from "./invitations/invitations";
import { memberStore } from "./members/members";
import { organizationStore } from "./organizations/organizations";
import { taskStore } from "./tasks/tasks";

/**
 * One module per area of the domain, built once from `deps`. Routes, and any other caller (a
 * worker, a script), go through these; only they touch the database. See ADR 0006.
 */
export function createModules(deps: Deps) {
  return {
    cases: caseStore(deps),
    tasks: taskStore(deps),
    caseRoles: caseRoleStore(deps),
    members: memberStore(deps),
    invitations: invitationStore(deps),
    organizations: organizationStore(deps),
  };
}

export type Modules = ReturnType<typeof createModules>;
