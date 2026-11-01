import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { meQuery } from "@/lib/api";
import { queryClient } from "@/lib/query-client";
import { canManage } from "@/lib/roles";
import { AcceptInvitePage } from "@/routes/accept-invite";
import { OperatorConsolePage } from "@/routes/operator-console";
import { CaseAuditLogPage } from "@/routes/cases/audit-log";
import { CaseLayout } from "@/routes/cases/case-layout";
import { CasesPage, validateCaseListSearch } from "@/routes/cases/list";
import { CaseOverviewPage } from "@/routes/cases/overview";
import { CaseEvidencePage } from "@/routes/cases/evidence";
import { CaseTasksPage } from "@/routes/cases/tasks";
import { CaseTimelinePage } from "@/routes/cases/timeline";
import { OrgAuditLogPage } from "@/routes/settings/audit-log";
import { SettingsLayout } from "@/routes/settings/layout";
import { MembersPage } from "@/routes/settings/members";
import { SignInPage } from "@/routes/sign-in";

export { queryClient };

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
});

/** Signed-in Members only; Operators go to their console. */
const requireMember = async ({ context }: { context: { queryClient: QueryClient } }) => {
  const me = await context.queryClient.fetchQuery(meQuery);
  if (!me) throw redirect({ to: "/sign-in" });
  if (me.isOperator) throw redirect({ to: "/operator" });
  return { me };
};

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validateCaseListSearch,
  beforeLoad: requireMember,
  component: CasesPage,
});

const caseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cases/$number",
  beforeLoad: requireMember,
  component: CaseLayout,
});

const caseOverviewRoute = createRoute({
  getParentRoute: () => caseRoute,
  path: "/",
  component: CaseOverviewPage,
});

const caseTasksRoute = createRoute({
  getParentRoute: () => caseRoute,
  path: "/tasks",
  component: CaseTasksPage,
});

const caseEvidenceRoute = createRoute({
  getParentRoute: () => caseRoute,
  path: "/evidence",
  component: CaseEvidencePage,
});

const caseTimelineRoute = createRoute({
  getParentRoute: () => caseRoute,
  path: "/timeline",
  component: CaseTimelinePage,
});

const caseAuditLogRoute = createRoute({
  getParentRoute: () => caseRoute,
  path: "/audit-log",
  component: CaseAuditLogPage,
});

const operatorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/operator",
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me) throw redirect({ to: "/sign-in" });
    if (!me.isOperator) throw redirect({ to: "/" });
    return { me };
  },
  component: OperatorConsolePage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me) throw redirect({ to: "/sign-in" });
    if (!canManage(me.organization?.role)) throw redirect({ to: "/" });
    return { me };
  },
  component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/members" });
  },
});

const membersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/members",
  component: MembersPage,
});

const orgAuditLogRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/audit-log",
  component: OrgAuditLogPage,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  component: SignInPage,
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$invitationId",
  component: AcceptInvitePage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    homeRoute,
    caseRoute.addChildren([caseOverviewRoute, caseTimelineRoute, caseTasksRoute, caseEvidenceRoute, caseAuditLogRoute]),
    operatorRoute,
    settingsRoute.addChildren([settingsIndexRoute, membersRoute, orgAuditLogRoute]),
    signInRoute,
    inviteRoute,
  ]),
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
