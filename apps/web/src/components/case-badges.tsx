import { Badge } from "@/components/ui/badge";
import { type Resolution, resolutionLabel, type Severity, severityLabel, type Status, statusLabel } from "@/lib/cases";
import { cn } from "@/lib/utils";

/** Critical is solid, High a heavy outline, the rest a thin outline. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge
      variant={severity === "critical" ? "default" : "outline"}
      className={cn(severity === "high" && "border-2 border-foreground font-semibold")}
    >
      {severityLabel[severity]}
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
