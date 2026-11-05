import { caseReportStore } from "./case-reports/case-reports";
import { caseLinkStore } from "./case-links/case-links";
import { caseRoleStore } from "./case-roles/case-roles";
import { caseStore } from "./cases/cases";
import type { Deps } from "./deps";
import { discussionStore } from "./discussion/discussion";
import { evidenceStore } from "./evidence/evidence";
import { guestStore } from "./guests/guests";
import { alertStore } from "./alerts/alerts";
import { integrationStore } from "./integrations/integrations";
import { internalStore } from "./internal/internal";
import { bulkLookupStore } from "./observables/bulk-lookup";
import { assetStore, ignoredObservableStore, observableStore } from "./observables/observables";
import { invitationStore } from "./invitations/invitations";
import { memberStore } from "./members/members";
import { metricsStore } from "./metrics/metrics";
import { notificationStore } from "./notifications/notifications";
import { organizationStore } from "./organizations/organizations";
import { responseActionStore } from "./response-actions/response-actions";
import { searchStore } from "./search/search";
import { ssoStore } from "./sso/sso";
import { tagStore } from "./tags/tags";
import { teamsChannelStore } from "./teams/teams";
import { taskStore } from "./tasks/tasks";
import { timelineStore } from "./timeline/timeline";

/**
 * One module per area of the domain, built once from `deps`. Routes, and any other caller (a
 * worker, a script), go through these; only they touch the database. See ADR 0006.
 */
export function createModules(deps: Deps) {
  const responseActions = responseActionStore(deps);
  const readers = {
    cases: caseStore(deps),
    tasks: taskStore(deps),
    timeline: timelineStore(deps),
    evidence: evidenceStore(deps),
    observables: observableStore(deps, responseActions),
    assets: assetStore(deps),
    responseActions,
  };
  return {
    ...readers,
    ignoredObservables: ignoredObservableStore(deps),
    bulkLookup: bulkLookupStore(deps, readers.observables),
    caseRoles: caseRoleStore(deps),
    discussion: discussionStore(deps),
    caseLinks: caseLinkStore(deps),
    tags: tagStore(deps),
    guests: guestStore(deps),
    internal: internalStore(deps),
    members: memberStore(deps),
    invitations: invitationStore(deps),
    organizations: organizationStore(deps),
    integrations: integrationStore(deps),
    alerts: alertStore(deps),
    notifications: notificationStore(deps),
    teamsChannel: teamsChannelStore(deps),
    sso: ssoStore(deps),
    search: searchStore(deps),
    metrics: metricsStore(deps),
    caseReports: caseReportStore(deps, readers),
  };
}

export type Modules = ReturnType<typeof createModules>;
