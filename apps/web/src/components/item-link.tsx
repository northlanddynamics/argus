import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ItemKind } from "@/lib/observables";

/** A link to an Observable's or Asset's own page. */
export function ItemLink({ kind, id, children, ...rest }: { kind: ItemKind; id: string; className?: string; title?: string; "aria-label"?: string; children: ReactNode }) {
  return kind === "observable" ? (
    <Link to="/observables/$id" params={{ id }} {...rest}>
      {children}
    </Link>
  ) : (
    <Link to="/assets/$id" params={{ id }} {...rest}>
      {children}
    </Link>
  );
}
