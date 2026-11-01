import { caseLinkStore } from "./case-links/case-links";
import { caseRoleStore } from "./case-roles/case-roles";
import { caseStore } from "./cases/cases";
import type { Deps } from "./deps";
import { discussionStore } from "./discussion/discussion";
import { evidenceStore } from "./evidence/evidence";
import { assetStore, observableStore } from "./observables/observables";
import { invitationStore } from "./invitations/invitations";
import { memberStore } from "./members/members";
import { organizationStore } from "./organizations/organizations";
import { tagStore } from "./tags/tags";
import { taskStore } from "./tasks/tasks";
import { timelineStore } from "./timeline/timeline";

/**
 * One module per area of the domain, built once from `deps`. Routes, and any other caller (a
 * worker, a script), go through these; only they touch the database. See ADR 0006.
 */
export function createModules(deps: Deps) {
  return {
    cases: caseStore(deps),
    tasks: taskStore(deps),
    caseRoles: caseRoleStore(deps),
    discussion: discussionStore(deps),
    timeline: timelineStore(deps),
    evidence: evidenceStore(deps),
    observables: observableStore(deps),
    assets: assetStore(deps),
    caseLinks: caseLinkStore(deps),
    tags: tagStore(deps),
    members: memberStore(deps),
    invitations: invitationStore(deps),
    organizations: organizationStore(deps),
  };
}

export type Modules = ReturnType<typeof createModules>;
