import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useMatchRoute, useNavigate, useParams, useRouteContext } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import { PresenceAvatars } from "@/components/presence-avatars";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, errorMessage } from "@/lib/api";
import {
  CASE_TYPES,
  type CaseType,
  caseKey,
  caseQuery,
  caseRef,
  caseTypeLabel,
  casesKey,
  isReadOnly,
  SEVERITIES,
  type Severity,
  severityLabel,
  REOPENED_STATUS,
  resolutionLabel,
  STATUSES,
  type Status,
  statusLabel,
} from "@/lib/cases";
import { CloseCaseDialog } from "@/routes/cases/close-case-dialog";
import { membersKey } from "@/routes/settings/members";

/** The Case's sections, each its own route under the Case. */
const SECTIONS = [
  "/cases/$number",
  "/cases/$number/timeline",
  "/cases/$number/tasks",
  "/cases/$number/evidence",
  "/cases/$number/observables",
  "/cases/$number/audit-log",
] as const;

/** Radix Select can't hold an empty value, so "Unassigned" gets one of its own. */
const UNASSIGNED = "unassigned";

type Changes = {
  status?: Exclude<Status, "closed">;
  severity?: Severity;
  caseType?: CaseType;
  assigneeId?: string | null;
  restricted?: boolean;
};

export const useCaseNumber = () => Number(useParams({ from: "/_app/cases/$number" }).number);

export function CaseLayout() {
  const { me } = useRouteContext({ from: "/_app/cases/$number" });
  const number = useCaseNumber();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const found = useQuery(caseQuery(number));
  const members = useQuery({
    queryKey: membersKey,
    queryFn: async () => (await api.organization.members.$get()).json(),
    enabled: !me.guest,
  });

  const change = useMutation({
    mutationFn: async (json: Changes) => {
      const res = await api.cases[":number"].$patch({ param: { number: String(number) }, json });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not change the Case"));
      const body = await res.json();
      if (!("case" in body)) throw new Error("Could not change the Case");
      return body.case;
    },
    onSuccess: (changed) => {
      void queryClient.invalidateQueries({ queryKey: casesKey });
      // The change took the Case out of the Member's sight (they unassigned a Restricted Case from themself).
      if (!changed) {
        queryClient.removeQueries({ queryKey: caseKey(number) });
        void navigate({ to: "/" });
        return;
      }
      queryClient.setQueryData(caseKey(number), changed);
    },
  });

  const reopen = useMutation({
    mutationFn: async () => {
      const res = await api.cases[":number"].reopen.$post({ param: { number: String(number) } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not reopen the Case"));
      const body = await res.json();
      if (!("case" in body)) throw new Error("Could not reopen the Case");
      return body.case;
    },
    onSuccess: (reopened) => {
      queryClient.setQueryData(caseKey(number), reopened);
      void queryClient.invalidateQueries({ queryKey: casesKey });
    },
  });

  const c = found.data;
  /** A Closed Case is read-only until an Admin reopens it; Guests change nothing. */
  const locked = change.isPending || !c || isReadOnly(c);
  const params = { number: String(number) };
  const section = SECTIONS.find((to) => matchRoute({ to, params })) ?? SECTIONS[0];
  return (
    <div className="mx-auto grid w-full grid-cols-1 max-w-6xl gap-4">
      {found.data === null && (
        <Alert>
          <AlertDescription>
            {me.guest
              ? `You don't have access to ${caseRef(number)} in ${me.guest.organization?.name ?? "this Organization"}.`
              : `There is no Case ${caseRef(number)} in your Organization.`}
          </AlertDescription>
        </Alert>
      )}
      {c && (
        <>
          <section className="grid gap-4" aria-label="Case">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="grid gap-1">
                <p className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                  {caseRef(c.number)}
                  {c.restricted && (
                    <Badge variant="outline" className="ml-1 font-sans">
                      <LockIcon aria-hidden /> Restricted
                    </Badge>
                  )}
                </p>
                <h1 className="text-2xl font-semibold tracking-tight">{c.title}</h1>
              </div>
              <div className="flex items-center gap-4">
                <PresenceAvatars number={c.number} />
                {!isReadOnly(c) && <CloseCaseDialog number={c.number} />}
              </div>
            </div>
            {c.closed && c.resolution && (
              <Alert className="border-amber-300 bg-amber-50 text-amber-950">
                <AlertTitle>Closed · {resolutionLabel[c.resolution]}</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    Closed by {c.closed.by.name} on {new Date(c.closed.at).toLocaleString()}. This Case is read-only
                    {c.can.reopen ? "." : "; only an Admin can reopen it."}
                  </span>
                  {c.can.reopen && (
                    <Button variant="outline" size="sm" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
                      Reopen to {statusLabel[REOPENED_STATUS]}
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
            <div className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="case-status" className="text-xs font-normal text-muted-foreground">
                  Status
                </FieldLabel>
                <Select
                  value={c.status}
                  disabled={locked}
                  onValueChange={(value) => change.mutate({ status: value as Changes["status"] })}
                >
                  <SelectTrigger id="case-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      // Closing needs a Resolution, set from its own dialog.
                      <SelectItem key={s} value={s} disabled={s === "closed"}>
                        {statusLabel[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="case-severity" className="text-xs font-normal text-muted-foreground">
                  Severity
                </FieldLabel>
                <Select value={c.severity} disabled={locked} onValueChange={(value) => change.mutate({ severity: value as Severity })}>
                  <SelectTrigger id="case-severity" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {severityLabel[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="case-type" className="text-xs font-normal text-muted-foreground">
                  Case Type
                </FieldLabel>
                <Select value={c.caseType} disabled={locked} onValueChange={(value) => change.mutate({ caseType: value as CaseType })}>
                  <SelectTrigger id="case-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CASE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {caseTypeLabel[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="case-assignee" className="text-xs font-normal text-muted-foreground">
                  Assignee
                </FieldLabel>
                <Select
                  value={c.assignee?.id ?? UNASSIGNED}
                  disabled={locked}
                  onValueChange={(value) => change.mutate({ assigneeId: value === UNASSIGNED ? null : value })}
                >
                  <SelectTrigger id="case-assignee" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                    {/* A former Member stays selectable until someone changes it. */}
                    {c.assignee && !members.data?.members.some((m) => m.userId === c.assignee?.id) && (
                      <SelectItem value={c.assignee.id}>{c.assignee.name}</SelectItem>
                    )}
                    {members.data?.members.map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {c.can.restrict && (
              <Field orientation="horizontal" data-disabled={locked}>
                <Checkbox
                  id="case-restricted"
                  checked={c.restricted}
                  disabled={locked}
                  onCheckedChange={(checked) => change.mutate({ restricted: checked === true })}
                />
                <FieldContent>
                  <FieldLabel htmlFor="case-restricted">Restricted</FieldLabel>
                  <FieldDescription>Only Admins, its Assignee and people with a Case Role on it can see it.</FieldDescription>
                </FieldContent>
              </Field>
            )}
            {(change.error ?? reopen.error) && (
              <Alert variant="destructive">
                <AlertDescription>{(change.error ?? reopen.error)?.message}</AlertDescription>
              </Alert>
            )}
          </section>
          <Tabs value={section} activationMode="manual">
            <TabsList variant="line" aria-label="Case sections" className="w-full justify-start overflow-x-auto overflow-y-hidden border-b">
              <TabsTrigger value="/cases/$number" className="flex-none" asChild>
                <Link to="/cases/$number" params={params}>
                  Overview
                </Link>
              </TabsTrigger>
              <TabsTrigger value="/cases/$number/timeline" className="flex-none" asChild>
                <Link to="/cases/$number/timeline" params={params}>
                  Timeline &amp; Discussion
                </Link>
              </TabsTrigger>
              <TabsTrigger value="/cases/$number/tasks" className="flex-none" asChild>
                <Link to="/cases/$number/tasks" params={params}>
                  Tasks
                  <Badge variant="secondary" className="tabular-nums">
                    {c.tasks.done}/{c.tasks.total}
                  </Badge>
                </Link>
              </TabsTrigger>
              <TabsTrigger value="/cases/$number/evidence" className="flex-none" asChild>
                <Link to="/cases/$number/evidence" params={params}>
                  Evidence
                </Link>
              </TabsTrigger>
              <TabsTrigger value="/cases/$number/observables" className="flex-none" asChild>
                <Link to="/cases/$number/observables" params={params}>
                  Observables &amp; Assets
                </Link>
              </TabsTrigger>
              {c.can.readAuditLog && (
                <TabsTrigger value="/cases/$number/audit-log" className="flex-none" asChild>
                  <Link to="/cases/$number/audit-log" params={params}>
                    Audit Log
                  </Link>
                </TabsTrigger>
              )}
            </TabsList>
            <TabsContent value={section}>
              <Outlet />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

