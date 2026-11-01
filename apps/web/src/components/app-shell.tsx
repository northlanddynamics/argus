import { Link, Outlet, useRouteContext, useRouterState } from "@tanstack/react-router";
import { Fragment } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { GuestSession } from "@/components/guest-nav";
import { LiveIndicator } from "@/components/live-indicator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type Me, useMe } from "@/lib/api";
import { caseRef } from "@/lib/cases";

const caseSections: Record<string, string> = {
  timeline: "Timeline & Discussion",
  tasks: "Tasks",
  evidence: "Evidence",
  observables: "Observables & Assets",
  "audit-log": "Audit Log",
};
const settingsSections: Record<string, string> = {
  members: "Members",
  integrations: "Integrations",
  "audit-log": "Organization Audit Log",
};

type Crumb = { label: string; to?: string; params?: Record<string, string> };

/** Where the page sits, read from the URL: "Cases / C-12 / Tasks". */
function crumbsFor(pathname: string, me: Me): Crumb[] {
  const workspace = me.guest ? me.guest.organization?.name : me.organization?.name;
  const trail = crumbsWithin(pathname, me);
  return workspace ? [{ label: workspace }, ...trail] : trail;
}

function crumbsWithin(pathname: string, me: Me): Crumb[] {
  const [area, id, section] = pathname.split("/").filter(Boolean);
  const cases = me.guest ? "Your Cases" : "Cases";
  if (area === "cases" && id) {
    const crumbs: Crumb[] = [{ label: cases, to: "/" }, { label: caseRef(Number(id)), to: "/cases/$number", params: { number: id } }];
    if (section && caseSections[section]) crumbs.push({ label: caseSections[section] });
    return crumbs;
  }
  if (area === "alerts") return [{ label: "Alerts" }];
  if (area === "settings") return [{ label: "Settings", to: "/settings" }, ...(id && settingsSections[id] ? [{ label: settingsSections[id] }] : [])];
  return [{ label: cases }];
}

/** The sidebar remembers being collapsed in a cookie (shadcn/ui's `sidebar_state`). */
const startsOpen = () => !document.cookie.split("; ").includes("sidebar_state=false");

/** The frame around every page a Member or Guest works in. */
export function AppShell() {
  const me = useMe(useRouteContext({ from: "/_app" }).me);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const crumbs = crumbsFor(pathname, me);
  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={startsOpen()} style={{ "--sidebar-width": "350px" } as React.CSSProperties}>
        <AppSidebar me={me} />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-center" />
            <Breadcrumb>
              <BreadcrumbList>
                {crumbs.map((c, i) => (
                  <Fragment key={c.label}>
                    {i > 0 && <BreadcrumbSeparator />}
                    <BreadcrumbItem className={i === 0 && crumbs.length > 1 ? "font-medium text-foreground" : undefined}>
                      {c.to && i < crumbs.length - 1 ? (
                        <BreadcrumbLink asChild>
                          <Link to={c.to} params={c.params}>
                            {c.label}
                          </Link>
                        </BreadcrumbLink>
                      ) : (
                        <BreadcrumbPage>{c.label}</BreadcrumbPage>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
            <div className="ml-auto flex items-center gap-4">
              {me.guest && <GuestSession guest={me.guest} />}
              <LiveIndicator />
            </div>
          </header>
          <div className="flex-1 p-4 md:p-6">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
