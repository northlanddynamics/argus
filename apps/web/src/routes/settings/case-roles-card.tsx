import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { type CaseRoleEntry, caseRoleCatalogKey, caseRoleCatalogQuery } from "@/lib/case-roles";

const cases = (n: number) => `on ${n} ${n === 1 ? "Case" : "Cases"}`;

/** A change to the catalog: refreshes it afterwards and reports its error, if any. */
function useCatalogAction<T>(setError: (error: string | null) => void, fn: (input: T) => Promise<Response>, fallback: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: T) => {
      const res = await fn(input);
      if (!res.ok) throw new Error(await errorMessage(res, fallback));
    },
    onMutate: () => setError(null),
    onError: (e) => setError(e.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: caseRoleCatalogKey }),
  });
}

/** Settings · the Case Role catalog: create, rename and retire. */
export function CaseRolesCard() {
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const catalog = useQuery(caseRoleCatalogQuery);

  const create = useCatalogAction(setError, (name: string) => api.organization["case-roles"].$post({ json: { name } }), "Could not create the Case Role");
  const rename = useCatalogAction(
    setError,
    ({ id, name }: { id: string; name: string }) => api.organization["case-roles"][":id"].$patch({ param: { id }, json: { name } }),
    "Could not rename the Case Role",
  );
  const retire = useCatalogAction(setError, (id: string) => api.organization["case-roles"][":id"].retire.$post({ param: { id } }), "Could not retire the Case Role");

  const onCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formEl = event.currentTarget;
    create.mutate(String(new FormData(formEl).get("name")), { onSuccess: () => formEl.reset() });
  };

  const active = catalog.data?.filter((r) => !r.retired) ?? [];
  const retired = catalog.data?.filter((r) => r.retired) ?? [];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Case Roles catalog</CardTitle>
        <CardDescription>The functions people can be given on a Case</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form className="grid items-end gap-2 sm:grid-cols-[1fr_auto]" onSubmit={onCreate}>
          <div className="grid gap-2">
            <Label htmlFor="new-case-role">New Case Role</Label>
            <Input id="new-case-role" name="name" required maxLength={60} placeholder="e.g. Lead, Forensics, Comms, Legal" />
          </div>
          <Button type="submit" variant="outline" disabled={create.isPending}>
            + New Case Role
          </Button>
        </form>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <ul className="grid divide-y">
          {active.map((r) =>
            renaming === r.id ? (
              <RenameRow
                key={r.id}
                role={r}
                pending={rename.isPending}
                onCancel={() => setRenaming(null)}
                onSave={(name) => rename.mutate({ id: r.id, name }, { onSuccess: () => setRenaming(null) })}
              />
            ) : (
              <li key={r.id} className="flex items-center justify-between gap-2 py-2" data-testid={`case-role-${r.name}`}>
                <span>
                  <span className="font-medium">{r.name}</span> <span className="text-sm text-muted-foreground">{cases(r.cases)}</span>
                </span>
                <span className="flex gap-2">
                  <Button variant="outline" size="sm" aria-label={`Rename ${r.name}`} onClick={() => setRenaming(r.id)}>
                    Rename
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Retire ${r.name}`}
                    onClick={() => {
                      if (window.confirm(`Retire ${r.name}? It won't be offered any more; people who hold it keep it.`)) retire.mutate(r.id);
                    }}
                  >
                    Retire
                  </Button>
                </span>
              </li>
            ),
          )}
          {catalog.data && active.length === 0 && <li className="py-2 text-sm text-muted-foreground">No Case Roles yet.</li>}
          {retired.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 py-2 text-muted-foreground">
              <span>
                {r.name} <span className="text-sm">{cases(r.cases)}</span>
              </span>
              <Badge variant="outline">Retired</Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function RenameRow({
  role,
  pending,
  onSave,
  onCancel,
}: {
  role: CaseRoleEntry;
  pending: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(role.name);
  return (
    <li className="py-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(name);
        }}
      >
        <Input aria-label={`New name for ${role.name}`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus />
        <Button type="submit" size="sm" disabled={pending}>
          Save
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </form>
    </li>
  );
}
