import { AlertMenu } from "@/components/alert-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SeverityBadge } from "@/components/case-badges";
import { itemReference } from "@/components/item-context";
import { ItemValue } from "@/components/item-value";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SirenIcon } from "lucide-react";
import { useState } from "react";
import { alertsKey, type CaseCorrelation, caseCorrelationsQuery } from "@/lib/alerts";
import { api } from "@/lib/api";
import { type CaseView, caseRef } from "@/lib/cases";

/**
 * Case Overview · Related Alerts (Correlation): the New Alerts sharing this Case's Important
 * Observables or its Assets (those on the Ignored list aside), most shared first. Shown at the top
 * of the Overview only when there are some, as a prompt that opens to the list. An Observable nobody has marked
 * Important never relates an Alert, however many share it. Argus never attaches on its own: the Member
 * attaches from here, or for a Closed Case an Admin reopens it and attaches in one step. Members only.
 */
export function RelatedAlertsPrompt({ c }: { c: CaseView }) {
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
  const [reviewing, setReviewing] = useState(false);
  if (!member) return null;
  const mode = related.data?.attach ?? null;
  const list = related.data?.alerts ?? [];
  if (related.isError)
    return (
      <Card size="sm">
        <CardContent>
          <p className="text-destructive">Couldn’t load the related Alerts.</p>
        </CardContent>
      </Card>
    );
  // Nothing to say until there's something to attach: an empty Correlation is not news.
  if (related.isPending || list.length === 0) return null;
  /** The Observables and Assets the Alerts share with the Case, each once. */
  const shared = [...new Map(list.flatMap((a) => a.shared).map((s) => [`${s.kind}-${s.id}`, s])).values()];
  return (
    <Card size="sm" aria-label="Related Alerts" role="region">
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <SirenIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <div className="grid min-w-0 flex-1 basis-64 gap-1.5">
            <p>
              <span className="font-medium">
                {list.length} New {list.length === 1 ? "Alert shares" : "Alerts share"}
              </span>{" "}
              this Case’s Important Observables or Assets
            </p>
            <SharedItems items={shared.slice(0, 4)} more={shared.length - 4} />
          </div>
          <Button variant="outline" size="sm" aria-expanded={reviewing} onClick={() => setReviewing((r) => !r)}>
            {reviewing ? "Hide" : mode ? "Review and attach" : "Review"}
          </Button>
        </div>
        {reviewing && (
          <ul className="grid gap-2" aria-label="Related Alerts">
            {list.map((a) => (
              <li key={a.alert.id} className="grid gap-1.5 rounded-lg border p-2">
                <div className="flex min-w-0 items-center gap-2">
                  <SeverityBadge severity={a.alert.severity} />
                  <AlertMenu falconUrl={a.alert.falconUrl}>
                    <Link to="/alerts" search={{ alert: a.alert.id }} className="min-w-0 truncate font-medium underline-offset-4 hover:underline" title={a.alert.title}>
                      {a.alert.title}
                    </Link>
                  </AlertMenu>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{a.sharedCount} shared</span>
                </div>
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={a.alert.externalId}>
                  {a.alert.externalId}
                </span>
                <SharedItems items={a.shared} more={0} />
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
        {!mode && <p className="text-xs text-muted-foreground">Closed: ask an Admin to reopen it to attach these Alerts.</p>}
        {attach.error && <p className="text-xs text-destructive">{attach.error.message}</p>}
      </CardContent>
    </Card>
  );
}

type Shared = CaseCorrelation["shared"][number];

/** What an Alert shares with the Case, each a link to its page with its usual menu. */
function SharedItems({ items, more }: { items: readonly Shared[]; more: number }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((s) => (
        <ItemValue key={`${s.kind}-${s.id}`} item={itemReference(s.kind, s)} id={s.id} badge />
      ))}
      {more > 0 && <span className="text-xs text-muted-foreground">+{more} more</span>}
    </div>
  );
}
