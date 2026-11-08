import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { Link, Outlet, useMatchRoute, useNavigate, useParams, useRouteContext } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { LockIcon } from "lucide-react";
import { SeverityBadge, StatusBadge } from "@/components/case-badges";
import { PresenceAvatars } from "@/components/presence-avatars";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useActiveGuestNames } from "@/components/visibility";
import { tasksQuery } from "@/lib/tasks";
import { instant } from "@/lib/when";
import { CaseAccessDialog } from "@/routes/cases/case-access-dialog";
import { CloseCaseDialog } from "@/routes/cases/close-case-dialog";
import { ExportReportDialog } from "@/routes/cases/export-report-dialog";
import { membersKey } from "@/routes/settings/members";
import { cn } from "@/lib/utils";

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

/** 1–6 open the Case's sections in tab order, as the Case list's j and k move between Cases. */
function useSectionKeys(sections: readonly (typeof SECTIONS)[number][], params: { number: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=alertdialog], [role=listbox], [role=menu]")) return;
      const to = sections[Number(e.key) - 1];
      if (!to) return;
      e.preventDefault();
      void navigate({ to, params });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sections, params, navigate]);
}

/** Status, Severity, Case Type and Assignee: each field stops at 18rem, and the card hugs them on a wide page. */
const fieldsCard = "grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:w-fit lg:grid-cols-[repeat(4,minmax(0,18rem))]";

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
  const tasks = useQuery({ ...tasksQuery(number), enabled: !!found.data });
  const overdue = tasks.data?.filter((t) => t.overdue && !t.done).length ?? 0;
  const guestNames = useActiveGuestNames(number, !!found.data?.can.work);

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
  const params = useMemo(() => ({ number: String(number) }), [number]);
  const section = SECTIONS.find((to) => matchRoute({ to, params })) ?? SECTIONS[0];
  /** The sections this viewer has, in tab order: the Audit Log only for those who can read it. */
  const readAuditLog = !!c?.can.readAuditLog;
  const sections = useMemo(() => SECTIONS.filter((to) => to !== "/cases/$number/audit-log" || readAuditLog), [readAuditLog]);
  useSectionKeys(sections, params);
  /** "Overview (1)": the key that opens a section, on hover and for assistive tech. */
  const keyFor = (to: (typeof SECTIONS)[number]) => {
    const n = sections.indexOf(to) + 1;
    return { title: `Press ${n}`, "aria-keyshortcuts": String(n) };
  };
  return (
    <div className="grid w-full grid-cols-1 max-w-page gap-4">
      {found.data === null && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            {me.guest
              ? `You don't have access to ${caseRef(number)} in ${me.guest.organization?.name ?? "this Organization"}.`
              : `There is no Case ${caseRef(number)} in your Organization.`}
            <Button variant="outline" size="sm" asChild>
              <Link to="/">{me.guest ? "Back to your Cases" : "Back to Cases"}</Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {c && (
        <>
          <section className="grid gap-4" aria-label="Case">
            <PageHeader
              title={c.title}
              description={
                <p className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
                  {caseRef(c.number)}
                  <span className="contents font-sans">
                    <SeverityBadge severity={c.severity} />
                    {overdue > 0 && (
                      <Badge variant="outline" className="border-overdue-border text-overdue">
                        {overdue} overdue
                      </Badge>
                    )}
                    {c.restricted && (
                      <Badge variant="outline">
                        <LockIcon aria-hidden /> Restricted
                      </Badge>
                    )}
                  </span>
                </p>
              }
              actions={
                <>
                  <PresenceAvatars number={c.number} />
                  {c.can.work && (
                    <CaseAccessDialog
                      c={c}
                      guestNames={guestNames}
                      locked={locked}
                      error={change.variables?.restricted !== undefined ? change.error : null}
                      onRestrictedChange={(restricted) => change.mutate({ restricted })}
                    />
                  )}
                  <ExportReportDialog number={c.number} complete={c.can.exportCompleteReport} hasGuests={guestNames.length > 0} />
                  {!isReadOnly(c) && <CloseCaseDialog number={c.number} />}
                </>
              }
            />
            {c.closed && c.resolution && (
              <Alert className="border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80">
                <AlertTitle>Closed · {resolutionLabel[c.resolution]}</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    Closed by {c.closed.by.name} on {instant(c.closed.at)}. This Case is read-only
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
            {isReadOnly(c) ? (
              <dl className={cn("text-sm", fieldsCard)} aria-label="Case details">
                <div className="grid gap-1.5">
                  <dt className="text-xs text-muted-foreground">Status</dt>
                  <dd>
                    <StatusBadge status={c.status} resolution={c.resolution} />
                  </dd>
                </div>
                <div className="grid gap-1.5">
                  <dt className="text-xs text-muted-foreground">Severity</dt>
                  <dd>
                    <SeverityBadge severity={c.severity} />
                  </dd>
                </div>
                <div className="grid gap-1.5">
                  <dt className="text-xs text-muted-foreground">Case Type</dt>
                  <dd>{caseTypeLabel[c.caseType]}</dd>
                </div>
                <div className="grid gap-1.5">
                  <dt className="text-xs text-muted-foreground">Assignee</dt>
                  <dd>{c.assignee?.name ?? "Unassigned"}</dd>
                </div>
                {me.guest && c.status !== "closed" && (
                  <div className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">
                    You're a Guest on this Case: you can post in the Discussion, complete the Tasks you own and add Evidence.
                  </div>
                )}
              </dl>
            ) : (
            <div className={fieldsCard}>
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
                    {STATUSES.filter((s) => s !== "closed").map((s) => (
                      <SelectItem key={s} value={s}>
                        {statusLabel[s]}
                      </SelectItem>
                    ))}
                    {/* Closing needs a Resolution, so it has its own dialog. */}
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>To close it, use Close Case</SelectLabel>
                    </SelectGroup>
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
                <div className="flex h-4 items-center justify-between gap-2">
                  <FieldLabel htmlFor="case-assignee" className="text-xs font-normal text-muted-foreground">
                    Assignee
                  </FieldLabel>
                  {c.assignee?.id !== me.user.id && (
                    <Button
                      variant="link"
                      size="xs"
                      className="h-auto p-0 text-xs"
                      disabled={locked}
                      onClick={() => change.mutate({ assigneeId: me.user.id })}
                    >
                      Assign to me
                    </Button>
                  )}
                </div>
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
            )}
            {(change.error ?? reopen.error) && (
              <Alert variant="destructive">
                <AlertDescription>{(change.error ?? reopen.error)?.message}</AlertDescription>
              </Alert>
            )}
          </section>
          <Tabs value={section} activationMode="manual">
            <TabsList variant="line" aria-label="Case sections" className="w-full flex-wrap justify-start border-b group-data-horizontal/tabs:h-auto!">
              <TabsTrigger value="/cases/$number" className="h-8 flex-none" asChild {...keyFor("/cases/$number")}>
                <Link to="/cases/$number" params={params}>
                  Overview
                </Link>
              </TabsTrigger>
              <TabsTrigger value="/cases/$number/timeline" className="h-8 flex-none" asChild {...keyFor("/cases/$number/timeline")}>
                <Link to="/cases/$number/timeline" params={params}>
                  Timeline &amp; Discussion
                </Link>
              </TabsTrigger>
              <TabsTrigger value="/cases/$number/tasks" className="h-8 flex-none" asChild {...keyFor("/cases/$number/tasks")}>
                <Link to="/cases/$number/tasks" params={params}>
                  Tasks
                  <Badge variant="secondary" className="tabular-nums">
                    {c.tasks.done}/{c.tasks.total}
                  </Badge>
                  {overdue > 0 && (
                    <Badge variant="outline" className="border-overdue-border text-overdue tabular-nums">
                      {overdue} overdue
                    </Badge>
                  )}
                </Link>
              </TabsTrigger>
              <TabsTrigger value="/cases/$number/evidence" className="h-8 flex-none" asChild {...keyFor("/cases/$number/evidence")}>
                <Link to="/cases/$number/evidence" params={params}>
                  Evidence
                </Link>
              </TabsTrigger>
              <TabsTrigger value="/cases/$number/observables" className="h-8 flex-none" asChild {...keyFor("/cases/$number/observables")}>
                <Link to="/cases/$number/observables" params={params}>
                  Observables &amp; Assets
                </Link>
              </TabsTrigger>
              {c.can.readAuditLog && (
                <TabsTrigger value="/cases/$number/audit-log" className="h-8 flex-none" asChild {...keyFor("/cases/$number/audit-log")}>
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

