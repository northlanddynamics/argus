import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, errorMessage } from "@/lib/api";
import { caseRoleCatalogKey, caseRoleCatalogQuery } from "@/lib/case-roles";
import { type CaseView, caseKey, casesKey } from "@/lib/cases";
import { membersKey } from "@/routes/settings/members";

type Assignments = CaseView["caseRoles"];

/** Case page · Case Roles: who holds which, and giving or taking them away. */
export function CaseRolesPanel({ number, caseRoles, readOnly }: { number: number; caseRoles: Assignments; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const catalog = useQuery({ ...caseRoleCatalogQuery, enabled: adding });
  const members = useQuery({
    queryKey: membersKey,
    queryFn: async () => (await api.organization.members.$get()).json(),
    enabled: adding,
  });

  /** Shows the Case's new Case Roles, or leaves it when the Member can no longer see it. */
  const show = (next: Assignments | null) => {
    void queryClient.invalidateQueries({ queryKey: caseRoleCatalogKey });
    if (!next) {
      queryClient.removeQueries({ queryKey: caseKey(number) });
      void queryClient.invalidateQueries({ queryKey: casesKey });
      void navigate({ to: "/" });
      return;
    }
    queryClient.setQueryData(caseKey(number), (c: CaseView | null | undefined) => (c ? { ...c, caseRoles: next } : c));
  };

  const assign = useMutation({
    mutationFn: async (json: { caseRoleId: string; userId: string }) => {
      const res = await api.cases[":number"]["case-roles"].$post({ param: { number: String(number) }, json });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not give the Case Role"));
      const body = await res.json();
      if (!("caseRoles" in body)) throw new Error("Could not give the Case Role");
      return body.caseRoles;
    },
    onSuccess: (next) => {
      show(next);
      setAdding(false);
    },
  });

  const unassign = useMutation({
    mutationFn: async (assignmentId: string) => {
      const res = await api.cases[":number"]["case-roles"][":assignmentId"].$delete({ param: { number: String(number), assignmentId } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not take the Case Role away"));
      const body = await res.json();
      if (!("caseRoles" in body)) throw new Error("Could not take the Case Role away");
      return body.caseRoles;
    },
    onSuccess: show,
  });

  const onAssign = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    assign.mutate({ caseRoleId: String(form.get("caseRoleId")), userId: String(form.get("userId")) });
  };

  const error = assign.error ?? unassign.error;
  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle className="text-xs tracking-widest text-muted-foreground uppercase">Case Roles</CardTitle>
        {!readOnly && !adding && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              + Assign
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        {caseRoles.length ? (
          <ul className="grid gap-1 text-sm">
            {caseRoles.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1">
                  {a.caseRole.name}
                  {a.caseRole.retired && <Badge variant="outline">Retired</Badge>}
                </span>
                <span className="flex items-center gap-1">
                  {a.holder.name}
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Take ${a.caseRole.name} from ${a.holder.name}`}
                      disabled={unassign.isPending}
                      onClick={() => unassign.mutate(a.id)}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nobody holds a Case Role yet.</p>
        )}
        {adding && (
          <form className="grid gap-2 border-t pt-3" onSubmit={onAssign}>
            <Select name="caseRoleId" required>
              <SelectTrigger aria-label="Case Role" className="w-full">
                <SelectValue placeholder="Case Role…" />
              </SelectTrigger>
              <SelectContent>
                {catalog.data
                  ?.filter((r) => !r.retired)
                  .map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Select name="userId" required>
              <SelectTrigger aria-label="Member" className="w-full">
                <SelectValue placeholder="Member…" />
              </SelectTrigger>
              <SelectContent>
                {members.data?.members.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {catalog.data && !catalog.data.some((r) => !r.retired) && (
              <p className="text-xs text-muted-foreground">An Admin adds Case Roles in Settings · Members.</p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={assign.isPending}>
                Assign
              </Button>
            </div>
          </form>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
