import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams, useRouteContext } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { OrgNav } from "@/components/org-nav";
import { PresenceAvatars } from "@/components/presence-avatars";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { api, errorMessage } from "@/lib/api";
import {
  CASE_TYPES,
  type CaseType,
  caseKey,
  caseQuery,
  caseRef,
  caseTypeLabel,
  casesKey,
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

const tabLink =
  "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground data-[status=active]:border-foreground data-[status=active]:font-medium data-[status=active]:text-foreground";

type Changes = {
  status?: Exclude<Status, "closed">;
  severity?: Severity;
  caseType?: CaseType;
  assigneeId?: string | null;
  restricted?: boolean;
};

export const useCaseNumber = () => Number(useParams({ from: "/cases/$number" }).number);

export function CaseLayout() {
  const { me } = useRouteContext({ from: "/cases/$number" });
  const number = useCaseNumber();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const found = useQuery(caseQuery(number));
  const members = useQuery({
    queryKey: membersKey,
    queryFn: async () => (await api.organization.members.$get()).json(),
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
  /** A Closed Case is read-only until an Admin reopens it. */
  const locked = change.isPending || c?.status === "closed";
  return (
    <div className="min-h-svh bg-muted">
      <AppHeader email={me.user.email} badge={<OrgNav me={me} />} live />
      <main className="mx-auto grid max-w-6xl gap-4 p-6">
        <nav className="text-sm text-muted-foreground" aria-label="Breadcrumb">
          <Link to="/" className="text-primary underline">
            Cases
          </Link>{" "}
          / <span className="font-mono">{caseRef(number)}</span>
        </nav>
        {found.data === null && (
          <Alert>
            <AlertDescription>There is no Case {caseRef(number)} in your Organization.</AlertDescription>
          </Alert>
        )}
        {c && (
          <>
            <Card>
              <CardContent className="grid gap-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                      {caseRef(c.number)}
                      {c.restricted && (
                        <span className="flex items-center gap-1 font-sans">
                          · <LockIcon className="size-3" aria-hidden /> Restricted
                        </span>
                      )}
                    </p>
                    <h1 className="text-2xl font-semibold">{c.title}</h1>
                  </div>
                  <div className="flex items-center gap-4">
                    <PresenceAvatars number={c.number} />
                    {c.status !== "closed" && <CloseCaseDialog number={c.number} />}
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
                <div className="grid gap-4 sm:grid-cols-4">
                  <Field label="Status" id="case-status">
                    <NativeSelect
                      id="case-status"
                      value={c.status}
                      disabled={locked}
                      onChange={(e) => change.mutate({ status: e.target.value as Changes["status"] })}
                    >
                      {STATUSES.map((s) => (
                        // Closing needs a Resolution, set from its own dialog.
                        <NativeSelectOption key={s} value={s} disabled={s === "closed"}>
                          {statusLabel[s]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Severity" id="case-severity">
                    <NativeSelect
                      id="case-severity"
                      value={c.severity}
                      disabled={locked}
                      onChange={(e) => change.mutate({ severity: e.target.value as Severity })}
                    >
                      {SEVERITIES.map((s) => (
                        <NativeSelectOption key={s} value={s}>
                          {severityLabel[s]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Case Type" id="case-type">
                    <NativeSelect
                      id="case-type"
                      value={c.caseType}
                      disabled={locked}
                      onChange={(e) => change.mutate({ caseType: e.target.value as CaseType })}
                    >
                      {CASE_TYPES.map((t) => (
                        <NativeSelectOption key={t} value={t}>
                          {caseTypeLabel[t]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Assignee" id="case-assignee">
                    <NativeSelect
                      id="case-assignee"
                      value={c.assignee?.id ?? ""}
                      disabled={locked}
                      onChange={(e) => change.mutate({ assigneeId: e.target.value || null })}
                    >
                      <NativeSelectOption value="">Unassigned</NativeSelectOption>
                      {/* A former Member stays selectable until someone changes it. */}
                      {c.assignee && !members.data?.members.some((m) => m.userId === c.assignee?.id) && (
                        <NativeSelectOption value={c.assignee.id}>{c.assignee.name}</NativeSelectOption>
                      )}
                      {members.data?.members.map((m) => (
                        <NativeSelectOption key={m.userId} value={m.userId}>
                          {m.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                </div>
                {c.can.restrict && (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="case-restricted"
                      checked={c.restricted}
                      disabled={locked}
                      onCheckedChange={(checked) => change.mutate({ restricted: checked === true })}
                    />
                    <Label htmlFor="case-restricted">Restricted</Label>
                    <span className="text-sm text-muted-foreground">
                      Only Admins, its Assignee and people with a Case Role on it can see it.
                    </span>
                  </div>
                )}
                {(change.error ?? reopen.error) && (
                  <Alert variant="destructive">
                    <AlertDescription>{(change.error ?? reopen.error)?.message}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>
            <nav className="flex gap-1 border-b" aria-label="Case sections">
              <Link to="/cases/$number" params={{ number: String(number) }} activeOptions={{ exact: true }} className={tabLink}>
                Overview
              </Link>
              <Link to="/cases/$number/discussion" params={{ number: String(number) }} className={tabLink}>
                Discussion
              </Link>
              <Link to="/cases/$number/tasks" params={{ number: String(number) }} className={tabLink}>
                Tasks ({c.tasks.done}/{c.tasks.total})
              </Link>
              <Link to="/cases/$number/audit-log" params={{ number: String(number) }} className={tabLink}>
                Audit Log
              </Link>
            </nav>
            <Outlet />
          </>
        )}
      </main>
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
