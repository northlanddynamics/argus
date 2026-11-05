import { Link, Outlet, useRouteContext, useRouterState } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { GuestSession } from "@/components/guest-nav";
import { LiveIndicator } from "@/components/live-indicator";
import { NotificationBell } from "@/components/notification-bell";
import { SearchPalette } from "@/components/search/search-palette";
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
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type Me, useMe } from "@/lib/api";
import { caseRef } from "@/lib/cases";
import { cn } from "@/lib/utils";

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
  if (area === "search") return [{ label: "Search" }];
  if (area === "lookup") return [{ label: "Bulk Lookup" }];
  if (area === "observables") return [{ label: "Observable" }];
  if (area === "assets") return [{ label: "Asset" }];
  if (area === "dashboard") return [{ label: "Dashboard" }];
  if (area === "settings") return [{ label: "Settings", to: "/settings" }, ...(id && settingsSections[id] ? [{ label: settingsSections[id] }] : [])];
  return [{ label: cases }];
}

/** The sidebar remembers being collapsed in a cookie (shadcn/ui's `sidebar_state`). */
const startsOpen = () => !document.cookie.split("; ").includes("sidebar_state=false");

/** Areas with nothing to do with working Cases, where the work queue starts tucked away to give the page room. */
const tuckedArea = (pathname: string) => {
  const area = pathname.split("/")[1];
  return area === "settings" || area === "dashboard" ? area : null;
};

/**
 * Whether the sidebar is open: as the person left it, except in a tucked area, where it starts
 * collapsed until they open it there.
 */
function useSidebarOpen(pathname: string) {
  const [preferred, setPreferred] = useState(startsOpen);
  const [openedIn, setOpenedIn] = useState<string | null>(null);
  const tucked = tuckedArea(pathname);
  const open = tucked ? preferred && openedIn === tucked : preferred;
  const onOpenChange = (next: boolean) => {
    setPreferred(next);
    setOpenedIn(next ? tucked : null);
  };
  return { open, onOpenChange };
}

/** The frame around every page a Member or Guest works in. */
export function AppShell() {
  const me = useMe(useRouteContext({ from: "/_app" }).me);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const crumbs = crumbsFor(pathname, me);
  const sidebar = useSidebarOpen(pathname);
  return (
    <TooltipProvider>
      <SidebarProvider open={sidebar.open} onOpenChange={sidebar.onOpenChange} style={{ "--sidebar-width": "350px" } as React.CSSProperties}>
        {/* The first stop for the keyboard: past the sidebar and header to the page itself. */}
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:ring-3 focus:ring-ring/50 focus:outline-none"
        >
          Skip to content
        </a>
        <AppSidebar me={me} />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-center" />
            <Breadcrumb className="min-w-0">
              <BreadcrumbList className="flex-nowrap sm:flex-wrap">
                {crumbs.map((c, i) => (
                  <Fragment key={c.label}>
                    {/* On a phone only the current page is shown. */}
                    {i > 0 && <BreadcrumbSeparator className="hidden sm:block" />}
                    <BreadcrumbItem
                      className={cn(
                        i === 0 && crumbs.length > 1 && "font-medium text-foreground",
                        i < crumbs.length - 1 ? "hidden sm:inline-flex" : "min-w-0 truncate",
                      )}
                    >
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
            <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-4">
              <SearchPalette />
              {me.guest && <GuestSession guest={me.guest} />}
              <LiveIndicator />
              <NotificationBell />
            </div>
          </header>
          <div id="content" tabIndex={-1} className="flex-1 p-4 outline-none md:p-6">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
