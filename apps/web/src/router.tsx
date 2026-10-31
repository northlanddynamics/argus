import { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { meQuery } from "@/lib/api";
import { AcceptInvitePage } from "@/routes/accept-invite";
import { OperatorConsolePage } from "@/routes/operator-console";
import { OrganizationHomePage } from "@/routes/organization-home";
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
  routeTree: rootRoute.addChildren([homeRoute, operatorRoute, signInRoute, inviteRoute]),
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
