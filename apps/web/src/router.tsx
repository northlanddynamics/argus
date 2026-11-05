import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, Outlet, redirect } from "@tanstack/react-router";
import { meQuery } from "@/lib/api";
import { validateDashboardSearch } from "@/lib/metrics";
import { validateSearchPageSearch } from "@/lib/search";
import { queryClient } from "@/lib/query-client";
import { canManage } from "@/lib/roles";
import { AppShell } from "@/components/app-shell";
import { AcceptInvitePage } from "@/routes/accept-invite";
import { AlertQueuePage, validateAlertQueueSearch } from "@/routes/alerts/queue";
import { OperatorConsolePage } from "@/routes/operator-console";
import { CaseAuditLogPage } from "@/routes/cases/audit-log";
import { CaseLayout } from "@/routes/cases/case-layout";
import { validateCaseListSearch } from "@/routes/cases/list";
import { CaseOverviewPage } from "@/routes/cases/overview";
import { CaseEvidencePage } from "@/routes/cases/evidence";
import { CaseObservablesPage } from "@/routes/cases/observables";
import { CaseTasksPage } from "@/routes/cases/tasks";
import { CaseTimelinePage } from "@/routes/cases/timeline";
import { DashboardPage } from "@/routes/dashboard";
import { HomePage } from "@/routes/guest-home";
import { AssetPage, ObservablePage } from "@/routes/items/item-page";
import { GuestSignInPage, validateGuestSignInSearch } from "@/routes/guest-sign-in";
import { SearchPage } from "@/routes/search";
import { OrgAuditLogPage } from "@/routes/settings/audit-log";
import { SettingsLayout } from "@/routes/settings/layout";
import { IgnoredObservablesPage } from "@/routes/settings/ignored";
import { IntegrationsPage } from "@/routes/settings/integrations";
import { MembersPage } from "@/routes/settings/members";
import { SsoPage } from "@/routes/settings/sso";
import { SignInPage, validateSignInSearch } from "@/routes/sign-in";

export { queryClient };

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
});

/** Signed-in Members and Guests only; Operators go to their console. Fetches `me` afresh. */
const requireParticipant = async ({ context }: { context: { queryClient: QueryClient } }) => {
  const me = await context.queryClient.fetchQuery(meQuery);
  if (!me) throw redirect({ to: "/sign-in" });
  if (me.isOperator) throw redirect({ to: "/operator" });
  return { me };
};

/** Every page a Member or Guest works in: the navigation rail and the Active Cases panel around it. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  // Runs when entering the layout, not when moving between its pages, so pages whose content
  // depends on `me` (Home, Case) check again.
  beforeLoad: requireParticipant,
  component: AppShell,
});

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  validateSearch: validateCaseListSearch,
  beforeLoad: requireParticipant,
  component: HomePage,
});

const caseRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/cases/$number",
  beforeLoad: requireParticipant,
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

const caseObservablesRoute = createRoute({
  getParentRoute: () => caseRoute,
  path: "/observables",
  component: CaseObservablesPage,
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

/** The Alert queue: Members only. */
const alertsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/alerts",
  validateSearch: validateAlertQueueSearch,
  beforeLoad: ({ context }) => {
    if (!context.me.organization) throw redirect({ to: "/" });
  },
  component: AlertQueuePage,
});

/** The Metrics dashboard: Members only. */
const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboard",
  validateSearch: validateDashboardSearch,
  beforeLoad: ({ context }) => {
    if (!context.me.organization) throw redirect({ to: "/" });
  },
  component: DashboardPage,
});

/** An Observable's and an Asset's page, for Members and Guests; the API decides what each sees. */
const observableRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/observables/$id",
  component: ObservablePage,
});

const assetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/assets/$id",
  component: AssetPage,
});

/** Bulk Lookup: Members only. Loaded on first visit, since it carries the Public Suffix List. */
const bulkLookupRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/lookup",
  beforeLoad: ({ context }) => {
    if (!context.me.organization) throw redirect({ to: "/" });
  },
  component: lazyRouteComponent(() => import("@/routes/bulk-lookup"), "BulkLookupPage"),
});

/** Global search, for Members and Guests; the API decides what each finds. */
const searchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/search",
  validateSearch: validateSearchPageSearch,
  component: SearchPage,
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
  getParentRoute: () => appRoute,
  path: "/settings",
  beforeLoad: ({ context }) => {
    if (!canManage(context.me.organization?.role)) throw redirect({ to: "/" });
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

const ssoRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/sso",
  component: SsoPage,
});

const integrationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/integrations",
  component: IntegrationsPage,
});

const ignoredRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/ignored",
  component: IgnoredObservablesPage,
});

const orgAuditLogRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/audit-log",
  component: OrgAuditLogPage,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  validateSearch: validateSignInSearch,
  component: SignInPage,
});

const guestSignInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/guest/sign-in",
  validateSearch: validateGuestSignInSearch,
  component: GuestSignInPage,
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$invitationId",
  component: AcceptInvitePage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    appRoute.addChildren([
      homeRoute,
      caseRoute.addChildren([caseOverviewRoute, caseTimelineRoute, caseTasksRoute, caseEvidenceRoute, caseObservablesRoute, caseAuditLogRoute]),
      alertsRoute,
      dashboardRoute,
      searchRoute,
      bulkLookupRoute,
      observableRoute,
      assetRoute,
      settingsRoute.addChildren([settingsIndexRoute, membersRoute, ssoRoute, integrationsRoute, ignoredRoute, orgAuditLogRoute]),
    ]),
    operatorRoute,
    signInRoute,
    guestSignInRoute,
    inviteRoute,
  ]),
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
