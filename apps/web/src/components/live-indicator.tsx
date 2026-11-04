import { cn } from "@/lib/utils";
import { type LiveStatus, useLiveStatus } from "@/lib/live";

const shown: Record<LiveStatus, { label: string; dot: string }> = {
  connecting: { label: "Connecting…", dot: "bg-muted-foreground" },
  live: { label: "Live", dot: "bg-live" },
  reconnecting: { label: "Reconnecting…", dot: "bg-reconnecting" },
  reconnected: { label: "Reconnected · views refreshed", dot: "bg-live" },
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
