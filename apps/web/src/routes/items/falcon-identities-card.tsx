import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Time } from "@/components/time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { type ItemPage, itemPagesKey, refreshEnrichment } from "@/lib/observables";

type FalconIdentity = ItemPage["falconIdentities"][number]["identities"][number];
type IdentityFacts = NonNullable<FalconIdentity["enrichment"]["identity"]>;
type Lookup = NonNullable<ItemPage["falconIdentities"][number]["lookup"]>;

/** A yes/no fact Falcon may not have given; `flagged` is the answer that deserves attention. */
function YesNo({ value, flagged, yes = "Yes", no = "No" }: { value: boolean | null; flagged: boolean; yes?: string; no?: string }) {
  if (value === null) return null;
  const label = value ? yes : no;
  return value === flagged ? <Badge variant="outline">{label}</Badge> : <>{label}</>;
}

/** Falcon's risk factors, such as `STALE_ACCOUNT`, as words. */
const riskFactorLabel = (type: string) => type.toLowerCase().replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

/**
 * The Falcon Identity Protection identities an account resolves to, by CrowdStrike Integration,
 * each with what Falcon last reported about it (Enrichment, ADR 0009). An account is looked up by
 * UPN or email, by domain and SAM name, or by SAM name alone, which may match several identities:
 * the account is then ambiguous, and they are shown side by side. Opening the page asks again for
 * anything older than 15 minutes; Refresh asks again now. A signal brings the result.
 */
export function FalconIdentitiesCard({ item }: { item: ItemPage }) {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => refreshEnrichment(item.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: itemPagesKey }),
  });
  const identities = item.falconIdentities.flatMap((group) => group.identities.map((identity) => ({ group, identity })));
  const lookups = item.falconIdentities.flatMap((group) => (group.identities.length === 0 && group.lookup ? [{ group, lookup: group.lookup }] : []));
  const refreshing = identities.some((i) => i.identity.enrichment.refreshing) || lookups.some((l) => l.lookup.refreshing);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Falcon identity</CardTitle>
        {item.falconIdentities.length > 0 && (
          <CardAction>
            <Button variant="outline" size="sm" disabled={refresh.isPending || refreshing} onClick={() => refresh.mutate()}>
              <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} aria-hidden />
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        {refresh.error && (
          <Alert variant="destructive">
            <AlertDescription>{refresh.error.message}</AlertDescription>
          </Alert>
        )}
        {item.falconIdentities
          .filter((g) => g.integration.enrichmentUnavailable)
          .map((g) => (
            <Alert key={g.integration.id}>
              <AlertDescription>
                {g.integration.name}: {g.integration.enrichmentUnavailable}.
              </AlertDescription>
            </Alert>
          ))}
        {lookups.map(({ group, lookup }) => (
          <IdentityLookup key={group.integration.id} integration={group.integration.name} lookup={lookup} />
        ))}
        {item.falconIdentities.length === 0 ? (
          <p className="text-sm text-muted-foreground">No CrowdStrike Integration to look this account up in.</p>
        ) : identities.length === 0 ? null : (
          <div className={identities.length > 1 ? "grid gap-3 @3xl:grid-cols-2" : "grid gap-3"}>
            {identities.map(({ group, identity }) => (
              <section
                key={`${group.integration.id} ${identity.entityId}`}
                aria-label={`Falcon identity ${identity.enrichment.identity?.displayName ?? identity.entityId}`}
                className="grid min-w-0 content-start gap-3 rounded-lg border p-3"
              >
                <div className="grid gap-1">
                  <p className="text-sm font-medium break-words">{identity.enrichment.identity?.displayName ?? "Unnamed identity"}</p>
                  <p className="font-mono text-xs break-all text-muted-foreground">{identity.entityId}</p>
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{group.integration.name}</span>
                    {group.ambiguous && (
                      <Badge variant="outline" title="Several Falcon identities go by this account name for this Integration">
                        Ambiguous
                      </Badge>
                    )}
                    <span>
                      · recorded <Time iso={identity.recordedAt} />
                    </span>
                  </p>
                </div>
                <IdentityEnrichment enrichment={identity.enrichment} />
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** How looking the account up by name went, through an Integration with no identity recorded on it. */
function IdentityLookup({ integration, lookup }: { integration: string; lookup: Lookup }) {
  const { refreshing, checkedAt, notFound, error } = lookup;
  return (
    <section aria-label={`Looking up in ${integration}`} className="grid gap-1 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{integration}</p>
      {notFound ? (
        <p className="text-sm">Not found in Falcon.</p>
      ) : (
        !checkedAt && (
          <p className="text-sm text-muted-foreground">{refreshing ? "Looking up this account in Falcon…" : "Not looked up in Falcon yet."}</p>
        )
      )}
      {checkedAt && (
        <p className="text-xs text-muted-foreground">
          Checked <Time iso={checkedAt} />
          {refreshing && " · checking again…"}
        </p>
      )}
      {error && <p className="text-xs text-destructive">Last lookup failed: {error}</p>}
    </section>
  );
}

/** The values Falcon gave, joined by `by`; null when it gave none. */
const joined = (values: readonly (string | null)[], by: string) => values.filter(Boolean).join(by) || null;

/** What Falcon last reported about one identity, as of when it was fetched. */
function IdentityEnrichment({ enrichment }: { enrichment: FalconIdentity["enrichment"] }) {
  const { identity, fetchedAt, notFound, error, refreshing } = enrichment;
  const asOf = fetchedAt && (
    <p className="text-xs text-muted-foreground">
      As of <Time iso={fetchedAt} />
      {refreshing && " · refreshing…"}
    </p>
  );
  const problem = error && <p className="text-xs text-destructive">Last fetch failed: {error}</p>;
  if (notFound) {
    return (
      <div className="grid gap-1">
        <p className="text-sm">Not found in Falcon.</p>
        {asOf}
        {problem}
      </div>
    );
  }
  if (!identity) {
    return (
      <div className="grid gap-1">
        {refreshing ? <Skeleton className="h-24" /> : !error && <p className="text-sm text-muted-foreground">Not fetched from Falcon yet.</p>}
        {problem}
      </div>
    );
  }
  const facts: { label: string; value: ReactNode }[] = [
    { label: "Risk", value: <Risk identity={identity} /> },
    { label: "Risk factors", value: joined(identity.riskFactors.map((f) => riskFactorLabel(f.type)), ", ") },
    { label: "Enabled", value: <YesNo value={identity.enabled} flagged={false} /> },
    { label: "Locked out", value: <YesNo value={identity.lockedOut} flagged /> },
    { label: "Stale", value: <YesNo value={identity.stale} flagged /> },
    {
      label: "Privileged",
      value:
        identity.privileged === null ? null : (
          <>
            <YesNo value={identity.privileged} flagged />
            {identity.privilegedGroups.length > 0 && <span className="text-muted-foreground"> · {identity.privilegedGroups.join(", ")}</span>}
          </>
        ),
    },
    { label: "Watched", value: <YesNo value={identity.watched} flagged /> },
    { label: "Password set", value: identity.passwordLastSet && <Time iso={identity.passwordLastSet} /> },
    { label: "Password expires", value: <YesNo value={identity.passwordNeverExpires === null ? null : !identity.passwordNeverExpires} flagged={false} no="Never" /> },
    { label: "Last activity", value: identity.lastActivity && <Time iso={identity.lastActivity} /> },
    { label: "UPN", value: identity.upn },
    { label: "Email", value: identity.email },
    { label: "SAM name", value: identity.samAccountName },
    { label: "Department", value: joined([identity.department, identity.title], " · ") },
    { label: "Domain", value: identity.domain },
    { label: "OU", value: identity.ou },
    { label: "Endpoints", value: joined(identity.endpoints, ", ") },
  ];
  return (
    <div className="grid gap-2">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        {facts.map(({ label, value }) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words">{value ?? <span className="text-muted-foreground">—</span>}</dd>
          </div>
        ))}
      </dl>
      {asOf}
      {problem}
    </div>
  );
}

/** The identity's risk score out of 100, with Falcon's grade of it; marked when it isn't normal. */
function Risk({ identity }: { identity: IdentityFacts }) {
  const { riskScore, riskSeverity } = identity;
  if (riskScore === null && !riskSeverity) return null;
  const grade = riskSeverity ? riskSeverity.charAt(0) + riskSeverity.slice(1).toLowerCase() : null;
  const score = riskScore === null ? null : `${Math.round(riskScore * 100)}`;
  const label = joined([score, grade], " · ");
  return riskSeverity && riskSeverity.toUpperCase() !== "NORMAL" ? <Badge variant="outline">{label}</Badge> : <>{label}</>;
}
