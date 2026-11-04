import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import { BriefcaseIcon, ChartColumnIcon, SettingsIcon, ShieldIcon, SirenIcon } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { SeverityBadge } from "@/components/case-badges";
import { NavUser } from "@/components/nav-user";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { rowClass, WorkQueue } from "@/components/work-queue";
import type { Me } from "@/lib/api";
import { caseRef, severityLabel, statusLabel } from "@/lib/cases";
import { expiryLabel, type GuestCase, type GuestInfo, useOpenGuestCase } from "@/lib/guests";
import { canManage } from "@/lib/roles";
import { cn } from "@/lib/utils";

/**
 * The navigation rail, then the work queue (or a Guest's Cases). Collapsing the sidebar leaves only
 * the rail, and takes the hidden panel out of the Tab order. Based on the shadcn/ui `sidebar-09` block.
 */
export function AppSidebar({ me, ...props }: { me: Me } & ComponentProps<typeof Sidebar>) {
  const { state, isMobile } = useSidebar();
  const current = useOpenCaseNumber();
  return (
    <Sidebar collapsible="icon" className="overflow-hidden *:data-[sidebar=sidebar]:flex-row" {...props}>
      <NavRail me={me} />
      <Sidebar collapsible="none" className="min-h-0 flex-1" inert={state === "collapsed" && !isMobile}>
        {me.guest ? <GuestCasesPanel guest={me.guest} current={current} /> : <WorkQueue me={me} current={current} />}
        {/* On a phone the account sits at the bottom of the sheet, under the Cases. */}
        <SidebarFooter className="border-t md:hidden">
          <NavUser me={me} />
        </SidebarFooter>
      </Sidebar>
    </Sidebar>
  );
}

function NavRail({ me }: { me: Me }) {
  const { setOpen, setOpenMobile } = useSidebar();
  const closeMobile = () => setOpenMobile(false);
  const matchRoute = useMatchRoute();
  const onCases = !!matchRoute({ to: "/" }) || !!matchRoute({ to: "/cases/$number", fuzzy: true });
  const workspace = me.guest ? (me.guest.organization?.name ?? "Guest access") : me.organization?.name;
  return (
    <Sidebar collapsible="none" className="h-auto border-b md:h-full md:w-[calc(var(--sidebar-width-icon)+1px)]! md:border-r md:border-b-0">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="md:h-8 md:p-0" tooltip={{ children: workspace, hidden: false, className: "data-closed:animate-none" }}>
              <Link to="/" aria-label="Argus home" onClick={closeMobile}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <ShieldIcon className="size-4" />
                </div>
                <span className="truncate font-semibold tracking-widest">ARGUS</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent className="px-1.5 md:px-0">
            <nav aria-label="Main">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={onCases}
                  tooltip={{ children: me.guest ? "Your Cases" : "Cases", hidden: false, className: "data-closed:animate-none" }}
                  className="px-2.5 md:px-2"
                >
                  <Link
                    to="/"
                    aria-current={onCases ? (matchRoute({ to: "/" }) ? "page" : "location") : undefined}
                    onClick={() => {
                      setOpen(true);
                      closeMobile();
                    }}
                  >
                    <BriefcaseIcon />
                    <span>{me.guest ? "Your Cases" : "Cases"}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {me.organization && !me.guest && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={!!matchRoute({ to: "/alerts" })}
                    tooltip={{ children: "Alerts", hidden: false, className: "data-closed:animate-none" }}
                    className="px-2.5 md:px-2"
                  >
                    <Link to="/alerts" aria-current={matchRoute({ to: "/alerts" }) ? "page" : undefined} onClick={closeMobile}>
                      <SirenIcon />
                      <span>Alerts</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {me.organization && !me.guest && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={!!matchRoute({ to: "/dashboard" })}
                    tooltip={{ children: "Dashboard", hidden: false, className: "data-closed:animate-none" }}
                    className="px-2.5 md:px-2"
                  >
                    <Link to="/dashboard" aria-current={matchRoute({ to: "/dashboard" }) ? "page" : undefined} onClick={closeMobile}>
                      <ChartColumnIcon />
                      <span>Dashboard</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {canManage(me.organization?.role) && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={!!matchRoute({ to: "/settings", fuzzy: true })}
                    tooltip={{ children: "Settings", hidden: false, className: "data-closed:animate-none" }}
                    className="px-2.5 md:px-2"
                  >
                    <Link to="/settings" aria-current={matchRoute({ to: "/settings", fuzzy: true }) ? "location" : undefined} onClick={closeMobile}>
                      <SettingsIcon />
                      <span>Settings</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="max-md:hidden">
        <NavUser me={me} />
      </SidebarFooter>
    </Sidebar>
  );
}

/** The Case number in the URL, when a Case is open. */
const useOpenCaseNumber = () => {
  const { number } = useParams({ strict: false });
  return number ? Number(number) : null;
};

/** "Access until 12/1/2026", or "Access doesn't expire". */
const access = (c: GuestCase) => (c.expiresAt ? `Access ${expiryLabel(c.expiresAt)}` : "Access doesn't expire");

/** The Cases a Guest was invited to, across Organizations. */
function GuestCasesPanel({ guest, current }: { guest: GuestInfo; current: number | null }) {
  const { setOpenMobile } = useSidebar();
  const openCase = useOpenGuestCase(guest);
  const [opening, setOpening] = useState<GuestCase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const severalOrganizations = new Set(guest.cases.map((c) => c.organization.id)).size > 1;
  const here = (c: GuestCase) => c.organization.id === guest.organization?.id;

  /** Another Organization's Case: switch to it first, saying so, since that reloads everything. */
  const openElsewhere = (c: GuestCase) => {
    setError(null);
    setOpening(c);
    openCase(c)
      .then(() => setOpenMobile(false))
      .catch((e: Error) => setError(e.message))
      .finally(() => setOpening(null));
  };

  const row = (c: GuestCase) => (
    <>
      <span className="flex w-full items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{caseRef(c.number)}</span>
        <SeverityBadge severity={c.severity} short />
        <span className="ml-auto text-xs text-muted-foreground">{statusLabel[c.status]}</span>
      </span>
      <span className="line-clamp-2 leading-snug font-medium">{c.title}</span>
      <span className="text-xs text-muted-foreground">
        {opening === c
          ? `Opening in ${c.organization.name}…`
          : `${severalOrganizations ? `${c.organization.name} · ` : ""}${access(c)}`}
      </span>
    </>
  );
  const name = (c: GuestCase) =>
    [c.title, caseRef(c.number), severityLabel[c.severity], statusLabel[c.status], severalOrganizations && c.organization.name, access(c)]
      .filter(Boolean)
      .join(", ");

  return (
    <>
      <SidebarHeader className="border-b p-4">
        <h2 className="text-base font-medium text-foreground">
          Your Cases <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">{guest.cases.length}</span>
        </h2>
      </SidebarHeader>
      <SidebarContent>
        {error && (
          <Alert variant="destructive" className="m-3 w-auto">
            <AlertTitle>That Case didn't open</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <nav aria-label="Your Cases" aria-busy={opening !== null}>
          <ul>
            {guest.cases.map((c) => {
              const active = here(c) && c.number === current;
              return (
                <li key={`${c.organization.id}:${c.number}`}>
                  {here(c) ? (
                    <Link
                      to="/cases/$number"
                      params={{ number: String(c.number) }}
                      data-active={active}
                      aria-current={active ? "page" : undefined}
                      aria-label={name(c)}
                      className={rowClass}
                      onClick={() => {
                        setError(null);
                        setOpenMobile(false);
                      }}
                    >
                      {row(c)}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      aria-label={name(c)}
                      disabled={opening !== null}
                      className={cn(rowClass, "disabled:cursor-progress")}
                      onClick={() => openElsewhere(c)}
                    >
                      {row(c)}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {guest.cases.length === 0 && <p className="p-4 text-sm text-muted-foreground">You no longer have access to any Cases.</p>}
        </nav>
      </SidebarContent>
    </>
  );
}
