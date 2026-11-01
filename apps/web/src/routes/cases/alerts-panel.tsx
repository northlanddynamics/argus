import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SeverityBadge } from "@/components/case-badges";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { caseAlertsQuery } from "@/lib/alerts";

/** Case page · Alerts: the Alerts attached to this Case. Members only; they are moved and detached from the Alert queue. */
export function CaseAlertsPanel({ number }: { number: number }) {
  const alerts = useQuery(caseAlertsQuery(number));
  return (
    <Card className="self-start">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-xs tracking-widest text-muted-foreground uppercase">Alerts</CardTitle>
        <Link to="/alerts" search={{ status: "attached" }} className="text-xs text-primary underline">
          Alert queue
        </Link>
      </CardHeader>
      <CardContent>
        {alerts.data?.length ? (
          <ul className="grid gap-2 text-sm" aria-label="Attached Alerts">
            {alerts.data.map((a) => (
              <li key={a.id} className="grid gap-0.5">
                <span className="flex items-center gap-2">
                  <SeverityBadge severity={a.severity} />
                  <span className="truncate" title={a.title}>
                    {a.title}
                  </span>
                </span>
                <span className="font-mono text-xs text-muted-foreground">{a.externalId}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No Alerts attached.</p>
        )}
      </CardContent>
    </Card>
  );
}
