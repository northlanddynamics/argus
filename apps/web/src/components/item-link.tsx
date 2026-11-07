import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ItemKind } from "@/lib/observables";

/**
 * A link to an Observable's or Asset's own page. `fromCase` is the Case it was opened from, which the
 * page's breadcrumb leads back to.
 */
export function ItemLink({
  kind,
  id,
  fromCase,
  children,
  ...rest
}: {
  kind: ItemKind;
  id: string;
  fromCase?: number;
  className?: string;
  title?: string;
  "aria-label"?: string;
  children: ReactNode;
}) {
  const search = fromCase === undefined ? {} : { from: fromCase };
  return kind === "observable" ? (
    <Link to="/observables/$id" params={{ id }} search={search} {...rest}>
      {children}
    </Link>
  ) : (
    <Link to="/assets/$id" params={{ id }} search={search} {...rest}>
      {children}
    </Link>
  );
}
