import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import { BriefcaseIcon, LockIcon, SettingsIcon, ShieldIcon, SirenIcon } from "lucide-react";
import { type ComponentProps, useDeferredValue, useState } from "react";
import { SeverityBadge } from "@/components/case-badges";
import { NavUser } from "@/components/nav-user";
import { Label } from "@/components/ui/label";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { ago } from "@/lib/alerts";
import { api, type Me } from "@/lib/api";
import { caseRef, casesKey, statusLabel } from "@/lib/cases";
import { expiryLabel, type GuestInfo, useOpenGuestCase } from "@/lib/guests";
import { canManage } from "@/lib/roles";
import { tagLabel } from "@/lib/tags";
import { cn } from "@/lib/utils";

/** The Case list query for the "All open" view with no filters, shared with the Case list page. */
const activeCasesQuery = {
  queryKey: [...casesKey, { view: "open" }],
  queryFn: async () => {
    const res = await api.cases.$get({ query: { view: "open" } });
    if (!res.ok) throw new Error("Could not load Cases");
    return res.json();
  },
};

/** "4 min ago" today, the date before that. */
const when = (iso: string) =>
  Date.now() - Date.parse(iso) < 86_400_000 ? ago(iso) : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const itemClass =
  "flex w-full flex-col items-start gap-1.5 border-b px-4 py-3 text-left text-sm leading-tight last:border-b-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground";

/**
 * The navigation rail, then the Active Cases panel. Collapsing the sidebar leaves only the rail.
 * Based on the shadcn/ui `sidebar-09` block.
 */
export function AppSidebar({ me, ...props }: { me: Me } & ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" className="overflow-hidden *:data-[sidebar=sidebar]:flex-row" {...props}>
      <NavRail me={me} />
      <Sidebar collapsible="none" className="min-h-0 flex-1">
        {me.guest ? <GuestCasesPanel guest={me.guest} /> : <ActiveCasesPanel me={me} />}
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
            <SidebarMenuButton size="lg" asChild className="md:h-8 md:p-0" tooltip={{ children: workspace, hidden: false }}>
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
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={onCases}
                  tooltip={{ children: me.guest ? "Your Cases" : "Cases", hidden: false }}
                  className="px-2.5 md:px-2"
                >
                  <Link
                    to="/"
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
                    tooltip={{ children: "Alerts", hidden: false }}
                    className="px-2.5 md:px-2"
                  >
                    <Link to="/alerts" onClick={closeMobile}>
                      <SirenIcon />
                      <span>Alerts</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {canManage(me.organization?.role) && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={!!matchRoute({ to: "/settings", fuzzy: true })}
                    tooltip={{ children: "Settings", hidden: false }}
                    className="px-2.5 md:px-2"
                  >
                    <Link to="/settings" onClick={closeMobile}>
                      <SettingsIcon />
                      <span>Settings</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
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

const matches = (query: string, ...fields: string[]) => {
  const q = query.trim().toLowerCase();
  return !q || fields.some((f) => f.toLowerCase().includes(q));
};

/** Every Case that isn't Closed, newest activity first, refreshing live. */
function ActiveCasesPanel({ me }: { me: Me }) {
  const { setOpenMobile } = useSidebar();
  const cases = useQuery(activeCasesQuery);
  const [mineOnly, setMineOnly] = useState(false);
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search);
  const current = useOpenCaseNumber();
  const all = cases.data?.cases ?? [];
  const shown = all.filter(
    (c) => (!mineOnly || c.assignee?.id === me.user.id) && matches(query, c.title, caseRef(c.number), ...c.tags.map(tagLabel)),
  );
  return (
    <>
      <SidebarHeader className="gap-3.5 border-b p-4">
        <div className="flex w-full items-center justify-between">
          <div className="text-base font-medium text-foreground">
            Active Cases
            {cases.data && <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">{all.length}</span>}
          </div>
          <Label className="flex items-center gap-2 text-sm">
            <span>Mine</span>
            <Switch className="shadow-none" checked={mineOnly} onCheckedChange={setMineOnly} />
          </Label>
        </div>
        <SidebarInput placeholder="Search title, C-number or Tag…" aria-label="Search Active Cases" value={search} onChange={(e) => setSearch(e.target.value)} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-0 py-0">
          <SidebarGroupContent>
            <nav aria-label="Active Cases">
              {shown.map((c) => (
                <Link
                  key={c.number}
                  to="/cases/$number"
                  params={{ number: String(c.number) }}
                  data-active={c.number === current}
                  aria-current={c.number === current ? "page" : undefined}
                  className={itemClass}
                  onClick={() => setOpenMobile(false)}
                >
                  <div className="flex w-full items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{caseRef(c.number)}</span>
                    <SeverityBadge severity={c.severity} />
                    <span className="ml-auto text-xs text-muted-foreground" title={new Date(c.updatedAt).toLocaleString()}>
                      {when(c.updatedAt)}
                    </span>
                  </div>
                  <span className="flex w-full items-start gap-1.5 font-medium">
                    {c.restricted && (
                      <>
                        <LockIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <span className="sr-only">Restricted:</span>
                      </>
                    )}
                    <span className="line-clamp-2">{c.title}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {statusLabel[c.status]} · <span className={cn(!c.assignee && "italic")}>{c.assignee?.name ?? "Unassigned"}</span>
                  </span>
                </Link>
              ))}
            </nav>
            {cases.data && shown.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">
                {all.length === 0 ? "No active Cases." : mineOnly && !query.trim() ? "None assigned to you." : "No Cases match."}
              </p>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}

/** The Cases a Guest was invited to, across Organizations. */
function GuestCasesPanel({ guest }: { guest: GuestInfo }) {
  const { setOpenMobile } = useSidebar();
  const openCase = useOpenGuestCase(guest);
  const [error, setError] = useState<string | null>(null);
  const current = useOpenCaseNumber();
  return (
    <>
      <SidebarHeader className="border-b p-4">
        <div className="text-base font-medium text-foreground">
          Your Cases <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">{guest.cases.length}</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-0 py-0">
          <SidebarGroupContent>
            <nav aria-label="Your Cases">
              {guest.cases.map((c) => {
                const active = c.number === current && c.organization.id === guest.organization?.id;
                return (
                  <button
                    key={`${c.organization.id}:${c.number}`}
                    type="button"
                    data-active={active}
                    aria-current={active ? "page" : undefined}
                    className={itemClass}
                    onClick={() => {
                      setOpenMobile(false);
                      openCase(c).catch((e: Error) => setError(e.message));
                    }}
                  >
                    <span className="font-mono text-xs text-muted-foreground">{caseRef(c.number)}</span>
                    <span className="line-clamp-2 font-medium">{c.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {c.organization.name} · {expiryLabel(c.expiresAt)}
                    </span>
                  </button>
                );
              })}
            </nav>
            {guest.cases.length === 0 && <p className="p-4 text-sm text-muted-foreground">You no longer have access to any Cases.</p>}
            {error && <p className="p-4 text-sm text-destructive">{error}</p>}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}
