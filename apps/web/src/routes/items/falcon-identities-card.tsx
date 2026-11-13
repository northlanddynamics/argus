import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { Fragment } from "react";
import { FactGroups, type FactGroup, joined } from "@/components/fact-groups";
import { Time } from "@/components/time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { type ItemPage, itemPagesKey, refreshEnrichment } from "@/lib/observables";
import { cn } from "@/lib/utils";

type FalconIdentity = ItemPage["falconIdentities"][number]["identities"][number];
type IdentityFacts = NonNullable<FalconIdentity["enrichment"]["identity"]>;
type Lookup = NonNullable<ItemPage["falconIdentities"][number]["lookup"]>;

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
                className={cn("grid min-w-0 content-start gap-3", identities.length > 1 && "rounded-lg border p-3")}
              >
                <div className="grid gap-0.5">
                  <p className="text-sm font-medium break-words">{identity.enrichment.identity?.displayName ?? "Unnamed identity"}</p>
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                    <span className="font-mono break-all">{identity.entityId}</span>
                    <span>· {group.integration.name}</span>
                    {group.ambiguous && (
                      <>
                        <Badge variant="outline" title="Several Falcon identities go by this account name for this Integration">
                          Ambiguous
                        </Badge>
                        <span>
                          · recorded <Time iso={identity.recordedAt} />
                        </span>
                      </>
                    )}
                    {identity.enrichment.fetchedAt && (
                      <span>
                        · as of <Time iso={identity.enrichment.fetchedAt} />
                        {identity.enrichment.refreshing && " · refreshing…"}
                      </span>
                    )}
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

/**
 * The yes/no answers Falcon gave about an identity. `flagged` is the answer that deserves attention:
 * it is shown as a badge saying `flag`; the other answer joins one muted line saying `fine`.
 */
const states = (identity: IdentityFacts) =>
  [
    { value: identity.enabled, flagged: false, flag: "Disabled", fine: "Enabled" },
    { value: identity.lockedOut, flagged: true, flag: "Locked out", fine: "not locked out" },
    { value: identity.stale, flagged: true, flag: "Stale", fine: "not stale" },
    { value: identity.privileged, flagged: true, flag: "Privileged", fine: "not privileged" },
    { value: identity.watched, flagged: true, flag: "Watched", fine: "not watched" },
    { value: identity.passwordNeverExpires, flagged: true, flag: "Password never expires", fine: "password expires" },
  ].filter((s): s is typeof s & { value: boolean } => s.value !== null);

/**
 * What Falcon last reported about one identity: its risk and anything about it that deserves
 * attention first, then the rest in groups. When it was fetched is said above it.
 */
function IdentityEnrichment({ enrichment }: { enrichment: FalconIdentity["enrichment"] }) {
  const { identity, notFound, error, refreshing } = enrichment;
  const problem = error && <p className="text-xs text-destructive">Last fetch failed: {error}</p>;
  if (notFound) {
    return (
      <div className="grid gap-1">
        <p className="text-sm">Not found in Falcon.</p>
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
  const answered = states(identity);
  const flags = answered.filter((s) => s.value === s.flagged);
  const fine = answered.filter((s) => s.value !== s.flagged);
  const hasRisk = identity.riskScore !== null || !!identity.riskSeverity;
  const groups: FactGroup[] = [
    {
      label: "Identifiers",
      facts: [
        { label: "UPN", value: identity.upn && <span className="font-mono text-xs">{identity.upn}</span> },
        { label: "Email", value: identity.email && <span className="font-mono text-xs">{identity.email}</span> },
        { label: "SAM name", value: identity.samAccountName && <span className="font-mono text-xs">{identity.samAccountName}</span> },
      ],
    },
    {
      label: "Directory",
      facts: [
        { label: "Domain", value: identity.domain },
        { label: "OU", value: identity.ou },
        { label: "Department", value: joined([identity.department, identity.title], " · ") },
        { label: "Privileged groups", value: joined(identity.privilegedGroups, ", ") },
      ],
    },
    {
      label: "Activity",
      facts: [
        { label: "Last activity", value: identity.lastActivity && <Time iso={identity.lastActivity} /> },
        { label: "Password set", value: identity.passwordLastSet && <Time iso={identity.passwordLastSet} /> },
        {
          label: "Endpoints",
          value: identity.endpoints.length > 0 && (
            <span className="font-mono text-xs">
              {identity.endpoints.map((endpoint, i) => (
                <Fragment key={endpoint}>
                  {i > 0 && ", "}
                  <span className="whitespace-nowrap">{endpoint}</span>
                </Fragment>
              ))}
            </span>
          ),
        },
      ],
    },
  ];
  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        {(hasRisk || flags.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            {hasRisk && <Risk identity={identity} />}
            {flags.map((s) => (
              <Badge key={s.flag} variant="outline">
                {s.flag}
              </Badge>
            ))}
          </div>
        )}
        {fine.length > 0 && <p className="text-xs text-muted-foreground">{fine.map((s, i) => (i === 0 ? s.fine.replace(/^./, (c) => c.toUpperCase()) : s.fine)).join(" · ")}</p>}
        {identity.riskFactors.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Risk factors: <span className="text-foreground">{identity.riskFactors.map((f) => riskFactorLabel(f.type)).join(", ")}</span>
          </p>
        )}
      </div>
      <FactGroups groups={groups} source="Falcon" />
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
  return riskSeverity && riskSeverity.toUpperCase() !== "NORMAL" ? (
    <Badge variant="outline">Risk {label}</Badge>
  ) : (
    <span className="text-muted-foreground">
      Risk <span className="text-foreground">{label}</span>
    </span>
  );
}
