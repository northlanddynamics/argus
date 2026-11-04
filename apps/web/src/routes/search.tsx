import { useQuery } from "@tanstack/react-query";
import { Link, useRouteContext, useSearch } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SeverityBadge, StatusBadge } from "@/components/case-badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { alertStatusLabel } from "@/lib/alerts";
import { useMe } from "@/lib/api";
import { caseRef } from "@/lib/cases";
import { assetTypeLabel, defang, observableTypeLabel } from "@/lib/observables";
import { searchQuery } from "@/lib/search";

type CaseRef = { number: number; title: string };

function CaseLink({ c }: { c: CaseRef }) {
  return (
    <Link to="/cases/$number" params={{ number: String(c.number) }} className="hover:underline">
      <span className="font-mono text-xs text-muted-foreground">{caseRef(c.number)}</span> {c.title}
    </Link>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {title} <span className="font-normal text-muted-foreground">({count})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">{children}</ul>
      </CardContent>
    </Card>
  );
}

type Item = { id: string; type: string; value: string; cases: CaseRef[] };

/** Observables and Assets, each with the Cases it is linked to; `show` is how its value is written. */
function Items<T extends Item>({ items, label, show }: { items: T[]; label: (item: T) => string; show: (item: T) => string }) {
  return items.map((item) => (
    <li key={item.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:gap-3">
      <Badge variant="outline" className="shrink-0">
        {label(item)}
      </Badge>
      <span className="min-w-0 font-mono text-sm break-all">{show(item)}</span>
      <span className="flex min-w-0 flex-wrap gap-x-3 text-sm sm:ml-auto">
        {item.cases.length ? item.cases.map((c) => <CaseLink key={c.number} c={c} />) : <span className="text-muted-foreground">Named by an Alert only</span>}
      </span>
    </li>
  ));
}

/** Global search: Cases, Alerts, Observables and Assets the signed-in person can see. */
export function SearchPage() {
  const { q = "" } = useSearch({ from: "/_app/search" });
  const me = useMe(useRouteContext({ from: "/_app" }).me);
  const results = useQuery(searchQuery(q));
  const data = results.data;
  const total = data ? data.cases.length + data.alerts.length + data.observables.length + data.assets.length : 0;

  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="text-sm text-muted-foreground">
          {me.guest
            ? "Searches the Cases you've been invited to."
            : 'Cases by title and Case Summary, Alerts, Observables and Assets. Use "quotes" for a phrase and -word to leave a word out.'}
        </p>
      </div>
      {!q && <p className="text-sm text-muted-foreground">Type in the search box above and press Enter.</p>}
      {q && results.isError && <p className="text-sm text-destructive">Could not search. Try again.</p>}
      {q && data && !total && <p className="text-sm text-muted-foreground">Nothing matches “{q}”.</p>}
      {data && (
        <div className={results.isPlaceholderData ? "grid gap-4 opacity-60" : "grid gap-4"}>
          <Section title="Cases" count={data.cases.length}>
            {data.cases.map((c) => (
              <li key={c.number} className="flex flex-wrap items-center gap-2 py-2">
                <CaseLink c={c} />
                {c.restricted && <LockIcon className="size-3.5 text-muted-foreground" aria-label="Restricted" />}
                <span className="ml-auto flex gap-2">
                  <SeverityBadge severity={c.severity} />
                  <StatusBadge status={c.status} />
                </span>
              </li>
            ))}
          </Section>
          <Section title="Alerts" count={data.alerts.length}>
            {data.alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 py-2">
                {me.guest ? (
                  <span>{a.title}</span>
                ) : (
                  <Link to="/alerts" search={{ status: "any", alert: a.id }} className="hover:underline">
                    {a.title}
                  </Link>
                )}
                <span className="text-sm text-muted-foreground">
                  {[a.host, a.userName, a.integration.name].filter(Boolean).join(" · ")}
                </span>
                <span className="ml-auto flex flex-wrap items-center gap-2 text-sm">
                  {a.case ? <CaseLink c={a.case} /> : <Badge variant="outline">{alertStatusLabel[a.status]}</Badge>}
                  <SeverityBadge severity={a.severity} />
                </span>
              </li>
            ))}
          </Section>
          <Section title="Observables" count={data.observables.length}>
            <Items items={data.observables} label={(o) => observableTypeLabel[o.type]} show={(o) => defang(o.type, o.value)} />
          </Section>
          <Section title="Assets" count={data.assets.length}>
            <Items items={data.assets} label={(a) => assetTypeLabel[a.type]} show={(a) => a.value} />
          </Section>
        </div>
      )}
    </div>
  );
}
