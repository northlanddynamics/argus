import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { BellIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { caseRef } from "@/lib/cases";
import { markAllRead, markRead, type Notification, notificationsKey, notificationsQuery } from "@/lib/notifications";
import { cn } from "@/lib/utils";

/**
 * The bell in the page header: the signed-in person's notifications, newest first, with how many are
 * unread. New ones arrive over the live socket (`lib/live.ts`) and are toasted as they come.
 */
export function NotificationBell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery(notificationsQuery);

  const open = useCallback(
    async (n: Notification) => {
      if (!n.read) queryClient.setQueryData(notificationsKey, await markRead(n.id));
      const params = { number: String(n.case.number) };
      if (n.section === "tasks") await navigate({ to: "/cases/$number/tasks", params });
      else if (n.section === "timeline") await navigate({ to: "/cases/$number/timeline", params });
      else if (n.section === "observables") await navigate({ to: "/cases/$number/observables", params });
      else await navigate({ to: "/cases/$number", params });
    },
    [queryClient, navigate],
  );

  // Toasts the unread notifications that weren't there before; none for those there on first load.
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!data) return;
    const before = known.current;
    known.current = new Set(data.notifications.map((n) => n.id));
    if (!before) return;
    for (const n of data.notifications.toReversed()) {
      if (n.read || before.has(n.id)) continue;
      toast(n.headline, {
        id: n.id,
        description: `${caseRef(n.case.number)} · ${n.case.title}`,
        action: { label: "Open", onClick: () => void open(n) },
      });
    }
  }, [data, open]);

  const unread = data?.unread ?? 0;
  const list = data?.notifications ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
          <BellIcon />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4 font-medium text-white dark:text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96">
        <div className="flex items-center justify-between">
          <DropdownMenuLabel>Notifications</DropdownMenuLabel>
          {unread > 0 && (
            <Button
              variant="link"
              size="sm"
              onClick={async () => queryClient.setQueryData(notificationsKey, await markAllRead())}
            >
              Mark all read
            </Button>
          )}
        </div>
        <DropdownMenuSeparator />
        {list.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {list.map((n) => (
              <DropdownMenuItem key={n.id} className="flex items-start gap-2" onSelect={() => void open(n)}>
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-primary")} aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className={cn("text-sm", !n.read && "font-medium")}>{n.headline}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {n.case.title} · {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                  </span>
                </span>
                {!n.read && <span className="sr-only">Unread</span>}
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
