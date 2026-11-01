import { cn } from "@/lib/utils";
import { type LiveStatus, useLiveStatus } from "@/lib/live";

const shown: Record<LiveStatus, { label: string; dot: string }> = {
  connecting: { label: "Connecting…", dot: "bg-muted-foreground" },
  live: { label: "Live", dot: "bg-green-500" },
  reconnecting: { label: "Reconnecting…", dot: "bg-amber-500" },
  reconnected: { label: "Reconnected · views refreshed", dot: "bg-green-500" },
};

/** The live connection's state, for the page header. Keeps the connection open while shown. */
export function LiveIndicator() {
  const { label, dot } = shown[useLiveStatus()];
  return (
    <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-2 rounded-full", dot)} aria-hidden />
      {label}
    </span>
  );
}
