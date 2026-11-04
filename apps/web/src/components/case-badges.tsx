import { Badge } from "@/components/ui/badge";
import { type Resolution, resolutionLabel, type Severity, severityLabel, type Status, statusLabel } from "@/lib/cases";
import { cn } from "@/lib/utils";

/** Shorter names for narrow places such as the sidebar; the full name stays in the tooltip. */
const shortSeverityLabel: Partial<Record<Severity, string>> = { informational: "Info" };

/** Critical is solid, High a heavy outline, the rest a thin outline. `short` abbreviates Informational. */
export function SeverityBadge({ severity, short = false }: { severity: Severity; short?: boolean }) {
  const label = short ? (shortSeverityLabel[severity] ?? severityLabel[severity]) : severityLabel[severity];
  return (
    <Badge
      variant={severity === "critical" ? "default" : "outline"}
      className={cn(severity === "high" && "border-2 border-foreground font-semibold")}
      title={label === severityLabel[severity] ? undefined : severityLabel[severity]}
    >
      {label}
    </Badge>
  );
}

/** The Status, and for a Closed Case its Resolution: "Closed · Benign". */
export function StatusBadge({ status, resolution }: { status: Status; resolution?: Resolution | null }) {
  return (
    <Badge variant="outline">
      {statusLabel[status]}
      {status === "closed" && resolution && ` · ${resolutionLabel[resolution]}`}
    </Badge>
  );
}
