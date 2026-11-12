import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRightIcon, LockIcon, SlidersHorizontalIcon, UsersIcon } from "lucide-react";
import { type DragEvent, type FocusEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { SeverityBadge } from "@/components/case-badges";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarContent, SidebarHeader, SidebarInput, useSidebar } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type AlertDrag, alertCount, endAlertDrag, useAlertDrag } from "@/lib/alert-drag";
import { api, type Me } from "@/lib/api";
import { caseRef, casesKey, SEVERITIES, severityLabel, statusLabel } from "@/lib/cases";
import { tagLabel } from "@/lib/tags";
import { useJustChanged } from "@/lib/use-just-changed";
import { cn } from "@/lib/utils";
import { exactTime, when } from "@/lib/when";

/** The Case list query for the "All open" view with no filters, shared with the Case list page. */
const openCasesQuery = {
  queryKey: [...casesKey, { view: "open" }],
  queryFn: async () => {
    const res = await api.cases.$get({ query: { view: "open" } });
    if (!res.ok) throw new Error(`The server answered ${res.status}`);
    return res.json();
  },
};

type OpenCase = Awaited<ReturnType<typeof openCasesQuery.queryFn>>["cases"][number];

const SECTIONS = ["mine", "others", "unassigned"] as const;
type SectionId = (typeof SECTIONS)[number];
type Sort = "severity" | "updated";
type SectionPrefs = { id: SectionId; visible: boolean; collapsed: boolean; sort: Sort };

const sectionLabel: Record<SectionId, string> = { mine: "Assigned to me", others: "Assigned to others", unassigned: "Unassigned" };
const sectionEmpty: Record<SectionId, string> = {
  mine: "Nothing assigned to you.",
  others: "No open Cases assigned to others.",
  unassigned: "No unassigned Cases.",
};
const sortLabel: Record<Sort, string> = { severity: "Severity", updated: "Last change" };
const DEFAULT_PREFS: SectionPrefs[] = SECTIONS.map((id) => ({ id, visible: true, collapsed: false, sort: "severity" }));

const prefsKey = (userId: string) => `argus:work-queue:${userId}`;

/** The Member's sections in their order, as last set in this browser; anything unreadable falls back to the default. */
function readPrefs(userId: string): SectionPrefs[] {
  try {
    const saved = JSON.parse(localStorage.getItem(prefsKey(userId)) ?? "null") as unknown;
    if (!Array.isArray(saved)) return DEFAULT_PREFS;
    const valid = saved.filter(
      (p): p is SectionPrefs =>
        SECTIONS.includes(p?.id) && typeof p.visible === "boolean" && typeof p.collapsed === "boolean" && (p.sort === "severity" || p.sort === "updated"),
    );
    const ids = new Set(valid.map((p) => p.id));
    if (ids.size !== valid.length) return DEFAULT_PREFS;
    return [...valid, ...DEFAULT_PREFS.filter((p) => !ids.has(p.id))];
  } catch {
    return DEFAULT_PREFS;
  }
}

function usePrefs(userId: string) {
  const [prefs, setPrefs] = useState(() => readPrefs(userId));
  const update = (next: SectionPrefs[]) => {
    setPrefs(next);
    try {
      localStorage.setItem(prefsKey(userId), JSON.stringify(next));
    } catch {
      // Not remembered in this browser; the change still applies until reload.
    }
  };
  const change = (id: SectionId, patch: Partial<SectionPrefs>) => update(prefs.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const move = (id: SectionId, by: -1 | 1) => {
    const at = prefs.findIndex((p) => p.id === id);
    const to = at + by;
    if (to < 0 || to >= prefs.length) return;
    const next = [...prefs];
    [next[at], next[to]] = [next[to]!, next[at]!];
    update(next);
  };
  return { prefs, change, move, reset: () => update(DEFAULT_PREFS) };
}

const sectionOf = (c: OpenCase, userId: string): SectionId => (!c.assignee ? "unassigned" : c.assignee.id === userId ? "mine" : "others");

const severityRank = (c: OpenCase) => SEVERITIES.indexOf(c.severity);
const byUpdated = (a: OpenCase, b: OpenCase) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number;
const sorters: Record<Sort, (a: OpenCase, b: OpenCase) => number> = {
  severity: (a, b) => severityRank(a) - severityRank(b) || byUpdated(a, b),
  updated: byUpdated,
};

const matches = (query: string, c: OpenCase) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [c.title, caseRef(c.number), c.assignee?.name ?? "Unassigned", statusLabel[c.status], ...c.tags.map(tagLabel)].some((f) =>
    f.toLowerCase().includes(q),
  );
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a screen reader hears for a Case row: the title first, then what sets it apart. */
const accessibleName = (c: OpenCase) =>
  [
    c.title,
    caseRef(c.number),
    severityLabel[c.severity],
    statusLabel[c.status],
    c.assignee?.name ?? "Unassigned",
    c.restricted && "Restricted",
    c.guests ? plural(c.guests, "Guest", "Guests") : null,
    c.overdueTasks ? plural(c.overdueTasks, "overdue Task", "overdue Tasks") : null,
    `changed ${when(c.updatedAt)}`,
  ]
    .filter(Boolean)
    .join(", ");

/** Re-renders every minute so "4 min ago" keeps up between refetches. */
function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
}

/**
 * The Member's work queue: open Cases in sections (assigned to them, to others, and to nobody), each
 * of which they can hide, collapse, sort and reorder. Refreshes live, holding its order still while
 * the pointer or focus is in it so nothing moves under a click.
 */
export function WorkQueue({ me, current }: { me: Me; current: number | null }) {
  const { setOpenMobile } = useSidebar();
  const userId = me.user.id;
  const cases = useQuery(openCasesQuery);
  const { prefs, change, move, reset } = usePrefs(userId);
  const [search, setSearch] = useState("");
  const [frozen, setFrozen] = useState<Map<number, number> | null>(null);
  const [lastFocused, setLastFocused] = useState<number | null>(null);
  const nav = useRef<HTMLElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const all = cases.data?.cases;
  const justChanged = useJustChanged(all);
  const drag = useAlertDrag();
  useMinuteTick();

  const filtering = search.trim() !== "";
  const sections = prefs
    .filter((p) => p.visible)
    .map((p) => {
      const items = (all ?? []).filter((c) => sectionOf(c, userId) === p.id && matches(search, c)).toSorted(sorters[p.sort]);
      // While frozen, rows keep the places they had; Cases that arrived since go to the end.
      if (frozen) items.sort((a, b) => (frozen.get(a.number) ?? Infinity) - (frozen.get(b.number) ?? Infinity));
      return { ...p, items };
    });
  const listed = sections.flatMap((s) => (s.collapsed ? [] : s.items.map((c) => c.number)));
  const tabStop = [lastFocused, current].find((n) => n !== null && listed.includes(n)) ?? listed[0];

  const counts = cases.data?.counts;
  const sectionCount = (s: (typeof sections)[number]) => {
    if (filtering || !counts) return s.items.length;
    return { mine: counts.mine, unassigned: counts.unassigned, others: counts.open - counts.mine - counts.unassigned }[s.id];
  };
  const total = filtering || !counts ? sections.reduce((n, s) => n + s.items.length, 0) : sections.reduce((n, s) => n + sectionCount(s), 0);

  // Bring the open Case into view when it changes (or the queue first loads), without moving the rest of the page.
  const loaded = all !== undefined;
  useEffect(() => {
    if (current === null || !loaded) return;
    nav.current?.querySelector(`[data-case="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current, loaded]);

  const freeze = () => setFrozen((f) => f ?? new Map(sections.flatMap((s) => s.items.map((c, i) => [c.number, i] as const))));
  const thaw = () => setFrozen(null);
  // Alerts dragged in hold the order still too, so the Case under the pointer stays put; it lets go once the drag ends elsewhere.
  useEffect(() => {
    if (!drag && !nav.current?.matches(":hover") && !nav.current?.contains(document.activeElement)) setFrozen(null);
  }, [drag]);
  const onBlur = (e: FocusEvent) => {
    if (!nav.current?.contains(e.relatedTarget as Node | null) && !nav.current?.matches(":hover")) thaw();
  };

  /** Up and Down (or j and k) move between Cases, Home and End jump to the first and last. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const links = [...(nav.current?.querySelectorAll<HTMLAnchorElement>("a[data-case]") ?? [])];
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at === -1) return;
    const target = { ArrowDown: at + 1, j: at + 1, ArrowUp: at - 1, k: at - 1, Home: 0, End: links.length - 1 }[e.key];
    if (target === undefined) return;
    e.preventDefault();
    links[Math.min(Math.max(target, 0), links.length - 1)]?.focus();
  };

  return (
    <>
      <SidebarHeader className="gap-3 border-b p-4">
        <div className="flex w-full items-center justify-between gap-2">
          <h2 className="text-base font-medium text-foreground">
            Work queue
            {cases.data && <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">{total}</span>}
          </h2>
          <QueueSettings prefs={prefs} change={change} move={move} reset={reset} />
        </div>
        <SidebarInput
          placeholder="Filter by title, C-number, Tag…"
          aria-label="Filter the work queue"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </SidebarHeader>
      <SidebarContent>
        {cases.isPending && <QueueSkeleton />}
        {cases.isError && (
          <Alert variant="destructive" className="m-3 w-auto">
            <AlertTitle>Cases couldn't be loaded</AlertTitle>
            {all && <AlertDescription>The queue may be out of date.</AlertDescription>}
            <AlertAction>
              <Button variant="outline" size="sm" disabled={cases.isFetching} onClick={() => cases.refetch()}>
                Try again
              </Button>
            </AlertAction>
          </Alert>
        )}
        {all && (
          <nav
            ref={nav}
            aria-label="Work queue"
            onPointerEnter={freeze}
            onPointerLeave={() => {
              if (!nav.current?.contains(document.activeElement)) thaw();
            }}
            onFocus={freeze}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            onDragEnter={() => drag && freeze()}
          >
            {drag && (
              <p role="status" className="border-b bg-sidebar-accent px-4 py-2 text-xs text-sidebar-accent-foreground">
                Drop on a Case to attach {alertCount(drag.count)}
              </p>
            )}
            {sections.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">Every section is hidden. Show one from the settings above.</p>
            )}
            {sections.map((s) => (
              <Collapsible key={s.id} open={!s.collapsed} onOpenChange={(open) => change(s.id, { collapsed: !open })}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="group/section sticky top-0 z-1 flex w-full items-center gap-1.5 border-b bg-sidebar px-4 py-2 text-left text-xs font-medium text-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset"
                  >
                    <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform duration-150 group-data-[state=open]/section:rotate-90" aria-hidden />
                    <span>{sectionLabel[s.id]}</span>
                    <span className="ml-auto font-normal text-muted-foreground tabular-nums">{sectionCount(s)}</span>
                    <span className="sr-only">{s.collapsed ? ", collapsed" : ""}</span>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {s.items.length === 0 ? (
                    <p className="border-b px-4 py-3 text-xs text-muted-foreground">{filtering ? "No matches." : sectionEmpty[s.id]}</p>
                  ) : (
                    <ul>
                      {s.items.map((c) => {
                        const active = c.number === current;
                        return (
                          <li key={c.number}>
                            <QueueRow
                              c={c}
                              active={active}
                              exact={active && pathname === `/cases/${c.number}`}
                              tabbable={c.number === tabStop}
                              changed={justChanged.has(c.number)}
                              onFocus={() => setLastFocused(c.number)}
                              onOpen={() => setOpenMobile(false)}
                              drag={drag}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CollapsibleContent>
              </Collapsible>
            ))}
            {all.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">
                No open Cases. New ones start from the{" "}
                <Link to="/alerts" className="underline underline-offset-3 hover:text-foreground" onClick={() => setOpenMobile(false)}>
                  Alert queue
                </Link>{" "}
                or Open Case on the Cases page.
              </p>
            )}
          </nav>
        )}
      </SidebarContent>
    </>
  );
}

export const rowClass =
  "flex w-full scroll-mt-9 flex-col items-start gap-1.5 border-b px-4 py-3 text-left text-sm outline-none transition-colors duration-700 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset data-[active=true]:bg-sidebar-accent data-[active=true]:ring-1 data-[active=true]:ring-foreground/20 data-[active=true]:ring-inset data-[active=true]:focus-visible:ring-2 data-[active=true]:focus-visible:ring-sidebar-ring";

function QueueRow({
  c,
  active,
  exact,
  tabbable,
  changed,
  onFocus,
  onOpen,
  drag,
}: {
  c: OpenCase;
  active: boolean;
  exact: boolean;
  tabbable: boolean;
  changed: boolean;
  onFocus: () => void;
  onOpen: () => void;
  /** Alerts being dragged from the Alert queue, which this Case takes when they're dropped on it. */
  drag: AlertDrag | null;
}) {
  const [hovered, setOver] = useState(false);
  // A drag that ends elsewhere (Escape, or dropped outside) leaves no Case marked.
  const over = hovered && drag !== null;
  const accept = (e: DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOver(true);
  };
  return (
    <Link
      to="/cases/$number"
      params={{ number: String(c.number) }}
      data-case={c.number}
      data-active={active}
      aria-current={active ? (exact ? "page" : "location") : undefined}
      aria-label={accessibleName(c)}
      tabIndex={tabbable ? 0 : -1}
      className={cn(rowClass, changed && "bg-sidebar-accent duration-0", over && "bg-sidebar-accent ring-2 ring-sidebar-ring duration-0 ring-inset")}
      onFocus={onFocus}
      onClick={onOpen}
      onDragEnter={accept}
      onDragOver={accept}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!drag) return;
        e.preventDefault();
        setOver(false);
        drag.drop(c.number);
        endAlertDrag();
      }}
    >
      <span className="flex w-full items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{caseRef(c.number)}</span>
        <SeverityBadge severity={c.severity} short />
        {c.overdueTasks > 0 && (
          <Badge variant="overdue">
            {c.overdueTasks} overdue
          </Badge>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums" title={exactTime(c.updatedAt)}>
          {when(c.updatedAt)}
        </span>
      </span>
      <span className="line-clamp-2 leading-snug font-medium">{c.title}</span>
      <span className="flex w-full min-w-0 items-center gap-3 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {statusLabel[c.status]} · {c.assignee?.name ?? "Unassigned"}
        </span>
        {(c.restricted || (c.guests ?? 0) > 0) && (
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {c.restricted && (
              <span className="inline-flex items-center gap-1">
                <LockIcon className="size-3" aria-hidden />
                Restricted
              </span>
            )}
            {(c.guests ?? 0) > 0 && (
              <span className="inline-flex items-center gap-1" title="Guests from outside the Organization can see this Case">
                <UsersIcon className="size-3" aria-hidden />
                {plural(c.guests ?? 0, "Guest", "Guests")}
              </span>
            )}
          </span>
        )}
      </span>
    </Link>
  );
}

/** Rows shaped like the real ones while the queue loads. */
export function QueueSkeleton() {
  return (
    <div aria-busy="true">
      <span role="status" className="sr-only">
        Loading Cases…
      </span>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="grid gap-2 border-b px-4 py-3" aria-hidden>
          <div className="flex items-center gap-2">
            <Skeleton className="h-3 w-8" />
            <Skeleton className="h-5 w-14 rounded-full" />
            <Skeleton className="ml-auto h-3 w-12" />
          </div>
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

function QueueSettings({
  prefs,
  change,
  move,
  reset,
}: {
  prefs: SectionPrefs[];
  change: (id: SectionId, patch: Partial<SectionPrefs>) => void;
  move: (id: SectionId, by: -1 | 1) => void;
  reset: () => void;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Arrange the work queue">
              <SlidersHorizontalIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Arrange the work queue</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>Sections</DropdownMenuLabel>
        {prefs.map((p, i) => (
          <DropdownMenuSub key={p.id}>
            <DropdownMenuSubTrigger>
              <span className={cn(!p.visible && "text-muted-foreground")}>{sectionLabel[p.id]}</span>
              <span className="ml-auto pl-4 text-xs text-muted-foreground">{p.visible ? sortLabel[p.sort] : "Hidden"}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-44">
              <DropdownMenuCheckboxItem checked={p.visible} onCheckedChange={(visible) => change(p.id, { visible })} onSelect={(e) => e.preventDefault()}>
                Show
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={p.sort} onValueChange={(sort) => change(p.id, { sort: sort as Sort })}>
                <DropdownMenuRadioItem value="severity" onSelect={(e) => e.preventDefault()}>
                  Severity, then last change
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="updated" onSelect={(e) => e.preventDefault()}>
                  Last change
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={i === 0} onSelect={(e) => (e.preventDefault(), move(p.id, -1))}>
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem disabled={i === prefs.length - 1} onSelect={(e) => (e.preventDefault(), move(p.id, 1))}>
                Move down
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={reset}>Reset to default</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
