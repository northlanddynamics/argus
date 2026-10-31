import { cn } from "@/lib/utils";
import { type LiveStatus, useLiveStatus } from "@/lib/live";

const shown: Record<LiveStatus, { label: string; dot: string }> = {
  connecting: { label: "Connecting…", dot: "bg-slate-400" },
  live: { label: "Live", dot: "bg-green-400" },
  reconnecting: { label: "Reconnecting…", dot: "bg-amber-400" },
  reconnected: { label: "Reconnected · views refreshed", dot: "bg-green-400" },
};

/** The live connection's state, for the header. Keeps the connection open while shown. */
export function LiveIndicator() {
  const { label, dot } = shown[useLiveStatus()];
  return (
    <span role="status" className="flex items-center gap-1.5 text-xs text-slate-300">
      <span className={cn("size-2 rounded-full", dot)} aria-hidden />
      {label}
    </span>
  );
}
