import { formatDistanceStrict } from "date-fns";
import { CopyIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** One clock for every Time on the page, ticking each 30 s, so "2 min ago" moves on without a reload. */
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  timer ??= setInterval(() => {
    now = Date.now();
    for (const l of listeners) l();
  }, 30_000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};
const useNow = () => useSyncExternalStore(subscribe, () => now);

/** "just now", "5 minutes ago", "3 days ago", "in 2 hours". */
export const relative = (iso: string, at = Date.now()) => {
  const date = new Date(iso);
  return Math.abs(at - date.getTime()) < 45_000 ? "just now" : formatDistanceStrict(date, at, { addSuffix: true });
};

const pad = (n: number) => String(n).padStart(2, "0");
/** "2026-01-12 19:38:05 UTC": the moment the same for everyone, to the second. */
export const utcText = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
};
/** The moment in the viewer's own locale and time zone, named so it can't be mistaken: "12 Jan 2026, 20:38:05 CET". */
export const regionalText = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });

const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${text}`);
  } catch {
    toast.error("Couldn't copy to the clipboard");
  }
};

/**
 * A moment, said relative to now ("3 hours ago"). Hovering shows it in full, in the viewer's time and
 * in UTC; right-clicking offers to copy either. `prefix` leads the words: "Sent 3 hours ago".
 */
export function Time({ iso, prefix, className }: { iso: string; prefix?: string; className?: string }) {
  // Re-renders as the shared clock ticks; the words are worked out from the time now.
  useNow();
  const text = relative(iso);
  const utc = utcText(iso);
  const regional = regionalText(iso);
  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <time dateTime={iso} className={cn("cursor-default tabular-nums", className)}>
              {prefix ? `${prefix} ${text}` : text}
              <span className="sr-only">{`, ${regional}`}</span>
            </time>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent className="grid gap-0.5 text-left">
          <span>{regional}</span>
          <span className="font-mono opacity-80">{utc}</span>
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent className="w-64">
        <ContextMenuLabel>
          <span className="font-normal">{regional}</span>
        </ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void copy(utc)}>
          <CopyIcon aria-hidden />
          Copy UTC
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copy(regional)}>
          <CopyIcon aria-hidden />
          Copy regional
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
