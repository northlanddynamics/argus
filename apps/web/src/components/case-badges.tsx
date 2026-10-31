import { Badge } from "@/components/ui/badge";
import { type Severity, severityLabel, type Status, statusLabel } from "@/lib/cases";
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

export function StatusBadge({ status }: { status: Status }) {
  return <Badge variant="outline">{statusLabel[status]}</Badge>;
}
