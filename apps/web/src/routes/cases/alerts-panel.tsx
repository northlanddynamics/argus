import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertMenu } from "@/components/alert-menu";
import { SeverityBadge } from "@/components/case-badges";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Visibility } from "@/components/visibility";
import { caseAlertsQuery } from "@/lib/alerts";
import { AlertDetails } from "@/routes/alerts/alert-details";
import { RailBody, RailHeader, RailSection, RailTitle } from "@/routes/cases/rail";
import { type CaseView, canMarkInternal } from "@/lib/cases";

/**
 * Case page · Alerts: the Alerts attached to this Case. Members see them all, each Internal until
 * shown to Guests, and open one in full in a flyout on the right, as the Alert queue shows it, to
 * move or detach it there; Guests see those shown to them.
 */
export function CaseAlertsPanel({ c }: { c: CaseView }) {
  const alerts = useQuery(caseAlertsQuery(c.number));
  const member = c.can.markInternal;
  /** The Alert open in the flyout, with the Case it was opened on: following a link to another Case closes it. */
  const [showing, setShowing] = useState<{ number: number; id: string } | null>(null);
  const open = showing?.number === c.number ? showing.id : null;
  // Guests learn nothing of Alerts they can't see, not even that there are none.
  if (!member && !alerts.data?.length) return null;
  return (
    <RailSection>
      <RailHeader>
        <RailTitle>Alerts{alerts.data?.length ? ` · ${alerts.data.length}` : ""}</RailTitle>
        {member && (
          <div>
            <Button variant="link" size="xs" asChild>
              <Link to="/alerts" search={{ status: "attached", case: c.number, falconComplete: "show" }}>
                Alert queue
              </Link>
            </Button>
          </div>
        )}
      </RailHeader>
      <RailBody>
        {alerts.data?.length ? (
          <ul className="grid gap-2.5" aria-label="Attached Alerts">
            {alerts.data.map((a) => (
              <AlertMenu key={a.id} falconUrl={a.falconUrl}>
                {/* One line for the Alert, one for its reference: a Falcon composite ID is long and has
                    nowhere to break, so it is cut short with the whole of it on hover. */}
                <li className="grid min-w-0 gap-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <SeverityBadge severity={a.severity} />
                    {member ? (
                      <button
                        type="button"
                        className="min-w-0 truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                        title={a.title}
                        aria-haspopup="dialog"
                        onClick={() => setShowing({ number: c.number, id: a.id })}
                      >
                        {a.title}
                      </button>
                    ) : (
                      <span className="truncate" title={a.title}>
                        {a.title}
                      </span>
                    )}
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={a.externalId ?? undefined}>
                      {a.externalId}
                    </span>
                    {member && (
                      <span className="ml-auto shrink-0">
                        <Visibility
                          number={c.number}
                          item={{ kind: "alert", id: a.id }}
                          internal={a.internal}
                          label={a.externalId ?? a.title}
                          canMark={canMarkInternal(c)}
                        />
                      </span>
                    )}
                  </span>
                </li>
              </AlertMenu>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">No Alerts attached.</p>
        )}
      </RailBody>
      {member && (
        <Sheet open={open !== null} onOpenChange={(o) => !o && setShowing(null)}>
          <SheetContent side="right" showCloseButton={false} className="w-full gap-0 overflow-y-auto overscroll-contain p-4 sm:w-[30rem] sm:max-w-none">
            <SheetTitle className="sr-only">Alert</SheetTitle>
            <SheetDescription className="sr-only">The Alert in full, as the Alert queue shows it</SheetDescription>
            {open && <AlertDetails id={open} onClose={() => setShowing(null)} />}
          </SheetContent>
        </Sheet>
      )}
    </RailSection>
  );
}
