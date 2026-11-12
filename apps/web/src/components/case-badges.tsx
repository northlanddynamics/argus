import { Badge } from "@/components/ui/badge";
import { type Resolution, resolutionLabel, type Severity, severityLabel, type Status, statusLabel } from "@/lib/cases";

/** Shorter names for narrow places such as the sidebar; the full name stays in the tooltip. */
const shortSeverityLabel: Partial<Record<Severity, string>> = { informational: "Info" };

/**
 * Colour fades with the Severity, and so does weight, so it never rests on colour alone: Critical
 * is a solid red fill, High an orange tint with a heavy outline, Medium and Low a yellow and a
 * blue outline, Informational a neutral one (the Badge variants of the same names).
 * `short` abbreviates Informational.
 */
export function SeverityBadge({ severity, short = false }: { severity: Severity; short?: boolean }) {
  const label = short ? (shortSeverityLabel[severity] ?? severityLabel[severity]) : severityLabel[severity];
  return (
    <Badge variant={severity} title={label === severityLabel[severity] ? undefined : severityLabel[severity]}>
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
