import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext, useSearch } from "@tanstack/react-router";
import { AppHeader } from "@/components/app-header";
import { SeverityBadge } from "@/components/case-badges";
import { OrgNav } from "@/components/org-nav";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ago,
  ALERT_STATUSES,
  alertKindLabel,
  alertsKey,
  type AlertStatus,
  alertStatusLabel,
  healthWord,
  integrationsQuery,
} from "@/lib/alerts";
import { api } from "@/lib/api";
import { SEVERITIES, type Severity, severityLabel } from "@/lib/cases";

/** `status` is New unless the URL says otherwise; "any" shows every Status. */
export type AlertQueueSearch = { status?: AlertStatus | "any"; severity?: Severity; integration?: string };

const pick = <T extends string>(list: readonly T[], value: unknown) => (list.includes(value as T) ? (value as T) : undefined);

/** Reads the queue's filters from the URL, ignoring anything unknown. */
export const validateAlertQueueSearch = (search: Record<string, unknown>): AlertQueueSearch => ({
  status: pick([...ALERT_STATUSES, "any"] as const, search.status),
  severity: pick(SEVERITIES, search.severity),
  integration: typeof search.integration === "string" && search.integration ? search.integration : undefined,
});

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The Alert queue: Alerts from the Organization's Integrations, newest first, refreshing live. */
export function AlertQueuePage() {
  const { me } = useRouteContext({ from: "/alerts" });
  const search = useSearch({ from: "/alerts" });
  const navigate = useNavigate({ from: "/alerts" });
  const status = search.status ?? "new";
  const setSearch = (next: Partial<AlertQueueSearch>) => navigate({ search: (prev) => ({ ...prev, ...next }) });

  const integrations = useQuery(integrationsQuery);
  const alerts = useQuery({
    queryKey: [...alertsKey, { ...search, status }],
    queryFn: async () => {
      const res = await api.alerts.$get({
        query: { ...(status !== "any" && { status }), severity: search.severity, integration: search.integration },
      });
      if (!res.ok) throw new Error("Could not load Alerts");
      return (await res.json()).alerts;
    },
  });

  return (
    <div className="min-h-svh bg-muted">
      <AppHeader email={me.user.email} badge={<OrgNav me={me} />} live />
      <main className="mx-auto grid max-w-6xl gap-4 p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold">Alerts</h1>
          <ul className="text-sm text-muted-foreground" aria-label="Integrations">
            {integrations.data?.map((i) => (
              <li key={i.id}>
                {i.name} · {healthWord(i).toLowerCase()} · {i.lastEventAt ? `last event ${ago(i.lastEventAt)}` : "no events yet"}
              </li>
            ))}
            {integrations.data?.length === 0 && <li>No Integrations yet: an Admin adds one in Settings.</li>}
          </ul>
        </div>
        <Card>
          <CardContent className="grid items-end gap-4 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto]">
            <div className="grid gap-2">
              <Label htmlFor="alert-status">Alert Status</Label>
              <NativeSelect id="alert-status" value={status} onChange={(e) => setSearch({ status: e.target.value as AlertStatus | "any" })}>
                <NativeSelectOption value="any">Any</NativeSelectOption>
                {ALERT_STATUSES.map((s) => (
                  <NativeSelectOption key={s} value={s}>
                    {alertStatusLabel[s]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="alert-severity">Severity</Label>
              <NativeSelect
                id="alert-severity"
                value={search.severity ?? ""}
                onChange={(e) => setSearch({ severity: (e.target.value || undefined) as Severity | undefined })}
              >
                <NativeSelectOption value="">Any</NativeSelectOption>
                {SEVERITIES.map((s) => (
                  <NativeSelectOption key={s} value={s}>
                    {severityLabel[s]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="alert-integration">Integration</Label>
              <NativeSelect
                id="alert-integration"
                value={search.integration ?? ""}
                onChange={(e) => setSearch({ integration: e.target.value || undefined })}
              >
                <NativeSelectOption value="">Any</NativeSelectOption>
                {integrations.data?.map((i) => (
                  <NativeSelectOption key={i.id} value={i.id}>
                    {i.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <p className="text-sm text-muted-foreground">
              {alerts.data && `${alerts.data.length} ${status === "any" ? "Alerts" : alertStatusLabel[status]} · new Alerts appear live`}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severity</TableHead>
                  <TableHead>Detection</TableHead>
                  <TableHead>Host / user</TableHead>
                  <TableHead>Integration</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.data?.map((a) => (
                  <TableRow key={a.id} data-testid={`alert-${a.externalId}`}>
                    <TableCell>
                      <SeverityBadge severity={a.severity} />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{a.title}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {a.externalId} · {alertKindLabel[a.kind]}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{a.host ?? "—"}</div>
                      {a.userName && <div className="text-xs text-muted-foreground">{a.userName}</div>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.integration.name}</TableCell>
                    <TableCell className="text-muted-foreground" title={new Date(a.receivedAt).toLocaleString()}>
                      {time(a.receivedAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{alertStatusLabel[a.status]}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {alerts.data?.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground">
                      No Alerts here.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
