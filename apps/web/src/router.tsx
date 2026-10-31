import { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { meQuery } from "@/lib/api";
import { canManage } from "@/lib/roles";
import { AcceptInvitePage } from "@/routes/accept-invite";
import { OperatorConsolePage } from "@/routes/operator-console";
import { OrganizationHomePage } from "@/routes/organization-home";
import { OrgAuditLogPage } from "@/routes/settings/audit-log";
import { SettingsLayout } from "@/routes/settings/layout";
import { MembersPage } from "@/routes/settings/members";
import { SignInPage } from "@/routes/sign-in";

export const queryClient = new QueryClient();

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me) throw redirect({ to: "/sign-in" });
    if (me.isOperator) throw redirect({ to: "/operator" });
    return { me };
  },
  component: OrganizationHomePage,
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
