import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useParams, useRouteContext } from "@tanstack/react-router";
import { AppHeader } from "@/components/app-header";
import { OrgNav } from "@/components/org-nav";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
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
  STATUSES,
  type Status,
  statusLabel,
} from "@/lib/cases";
import { membersKey } from "@/routes/settings/members";

const tabLink =
  "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground data-[status=active]:border-foreground data-[status=active]:font-medium data-[status=active]:text-foreground";

type Changes = { status?: Exclude<Status, "closed">; severity?: Severity; caseType?: CaseType; assigneeId?: string | null };

export const useCaseNumber = () => Number(useParams({ from: "/cases/$number" }).number);

export function CaseLayout() {
  const { me } = useRouteContext({ from: "/cases/$number" });
  const number = useCaseNumber();
  const queryClient = useQueryClient();
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
      queryClient.setQueryData(caseKey(number), changed);
      void queryClient.invalidateQueries({ queryKey: casesKey });
    },
  });

  const c = found.data;
  return (
    <div className="min-h-svh bg-muted">
      <AppHeader email={me.user.email} badge={<OrgNav me={me} />} />
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
                <div>
                  <p className="font-mono text-xs text-muted-foreground">{caseRef(c.number)}</p>
                  <h1 className="text-2xl font-semibold">{c.title}</h1>
                </div>
                <div className="grid gap-4 sm:grid-cols-4">
                  <Field label="Status" id="case-status">
                    <NativeSelect
                      id="case-status"
                      value={c.status}
                      disabled={change.isPending || c.status === "closed"}
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
                      disabled={change.isPending}
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
                      disabled={change.isPending}
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
                      disabled={change.isPending}
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
                {change.error && (
                  <Alert variant="destructive">
                    <AlertDescription>{change.error.message}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>
            <nav className="flex gap-1 border-b" aria-label="Case sections">
              <Link to="/cases/$number" params={{ number: String(number) }} activeOptions={{ exact: true }} className={tabLink}>
                Overview
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
