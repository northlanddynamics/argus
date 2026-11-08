import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SeverityBadge } from "@/components/case-badges";
import { Button } from "@/components/ui/button";
import { Visibility } from "@/components/visibility";
import { caseAlertsQuery } from "@/lib/alerts";
import { RailBody, RailHeader, RailSection, RailTitle } from "@/routes/cases/rail";
import { type CaseView, canMarkInternal } from "@/lib/cases";

/**
 * Case page · Alerts: the Alerts attached to this Case. Members see them all, each Internal until
 * shown to Guests, and move or detach them from the Alert queue; Guests see those shown to them.
 */
export function CaseAlertsPanel({ c }: { c: CaseView }) {
  const alerts = useQuery(caseAlertsQuery(c.number));
  const member = c.can.markInternal;
  // Guests learn nothing of Alerts they can't see, not even that there are none.
  if (!member && !alerts.data?.length) return null;
  return (
    <RailSection>
      <RailHeader>
        <RailTitle>Alerts</RailTitle>
        {member && (
          <div>
            <Button variant="link" size="xs" className="h-auto px-0" asChild>
              <Link to="/alerts" search={{ status: "attached" }}>
                Alert queue
              </Link>
            </Button>
          </div>
        )}
      </RailHeader>
      <RailBody>
        {alerts.data?.length ? (
          <ul className="grid gap-3 text-sm" aria-label="Attached Alerts">
            {alerts.data.map((a) => (
              <li key={a.id} className="grid gap-0.5">
                <span className="flex items-center gap-2">
                  <SeverityBadge severity={a.severity} />
                  <span className="truncate" title={a.title}>
                    {a.title}
                  </span>
                </span>
                <span className="font-mono text-xs text-muted-foreground">{a.externalId}</span>
                {member && (
                  <Visibility
                    number={c.number}
                    item={{ kind: "alert", id: a.id }}
                    internal={a.internal}
                    label={a.externalId}
                    canMark={canMarkInternal(c)}
                  />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No Alerts attached.</p>
        )}
      </RailBody>
    </RailSection>
  );
}
