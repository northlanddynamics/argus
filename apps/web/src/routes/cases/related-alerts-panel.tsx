import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SeverityBadge } from "@/components/case-badges";
import { ItemLink } from "@/components/item-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { alertsKey, type CaseCorrelation, caseCorrelationsQuery } from "@/lib/alerts";
import { api } from "@/lib/api";
import { type CaseView, caseRef } from "@/lib/cases";
import { assetTypeLabel, observableTypeLabel, shownObservable } from "@/lib/observables";

/**
 * Case page · Related Alerts (Correlation): the New Alerts sharing this Case's Observables or Assets
 * (those on the Ignored list aside), most shared first. Argus never attaches on its own: the Member
 * attaches from here, or for a Closed Case an Admin reopens it and attaches in one step. Members only.
 */
export function RelatedAlertsPanel({ c }: { c: CaseView }) {
  const member = c.can.markInternal;
  const related = useQuery({ ...caseCorrelationsQuery(c.number), enabled: member });
  const queryClient = useQueryClient();
  const attach = useMutation({
    mutationFn: async (a: CaseCorrelation) => {
      const res = await api.alerts.attach.$post({
        json: { case: c.number, alerts: [{ id: a.alert.id, version: a.alert.version }], reopen: related.data?.attach === "reopen_and_attach" },
      });
      const body = (await res.json()) as { error?: string; refused?: { externalId: string | null; detail: string }[] };
      if (!res.ok) throw new Error(body.error ?? "Couldn't attach the Alert");
      const refused = body.refused?.[0];
      if (refused) throw new Error(`${refused.externalId ?? "The Alert"} ${refused.detail}`);
    },
    onSettled: () => Promise.all([queryClient.invalidateQueries({ queryKey: alertsKey }), queryClient.invalidateQueries({ queryKey: ["cases", c.number] })]),
  });
  if (!member) return null;
  const mode = related.data?.attach ?? null;
  const list = related.data?.alerts ?? [];
  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle className="text-xs tracking-widest text-muted-foreground uppercase">Related Alerts</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {related.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : related.isError ? (
          <p className="text-destructive">Couldn’t load the related Alerts.</p>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground">No New Alert shares its Observables or Assets.</p>
        ) : (
          <ul className="grid gap-2" aria-label="Related Alerts">
            {list.map((a) => (
              <li key={a.alert.id} className="grid gap-1.5 rounded border p-2">
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={a.alert.severity} />
                  <Link to="/alerts" search={{ alert: a.alert.id }} className="min-w-0 truncate font-medium underline-offset-4 hover:underline" title={a.alert.title}>
                    {a.alert.title}
                  </Link>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{a.sharedCount} shared</span>
                </div>
                <span className="font-mono text-xs text-muted-foreground">{a.alert.externalId}</span>
                <div className="flex flex-wrap gap-1">
                  {a.shared.map((s) => (
                    <Badge key={`${s.kind}-${s.id}`} variant="outline" className="max-w-full truncate font-mono hover:bg-muted" title={s.value} asChild>
                      <ItemLink kind={s.kind} id={s.id}>
                        {s.kind === "observable" ? `${observableTypeLabel[s.type]} ${shownObservable(s.type, s.value)}` : `${assetTypeLabel[s.type]} ${s.value}`}
                      </ItemLink>
                    </Badge>
                  ))}
                </div>
                {mode && (
                  <div>
                    <Button size="sm" variant="outline" disabled={attach.isPending} onClick={() => attach.mutate(a)}>
                      {mode === "reopen_and_attach" ? `Reopen ${caseRef(c.number)} and attach` : "Attach"}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {!mode && list.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Closed: ask an Admin to reopen it to attach these Alerts.</p>}
        {attach.error && <p className="mt-2 text-xs text-destructive">{attach.error.message}</p>}
      </CardContent>
    </Card>
  );
}
