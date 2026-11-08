import { Link } from "@tanstack/react-router";
import { caseRef } from "@/lib/cases";
import { cn } from "@/lib/utils";

/**
 * A link to a Case by its reference, "C-12": monospace, underlined, its title on hover and read out
 * with the reference. Every table and line that names a Case by number uses it, so one looks like all.
 */
export function CaseRef({ number, title, to = "/cases/$number", className }: { number: number; title: string; to?: "/cases/$number" | "/cases/$number/observables"; className?: string }) {
  return (
    <Link
      to={to}
      params={{ number: String(number) }}
      title={title}
      aria-label={`${caseRef(number)} ${title}`}
      className={cn("rounded-sm font-mono text-xs text-foreground underline decoration-foreground/30 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50", className)}
    >
      {caseRef(number)}
    </Link>
  );
}
