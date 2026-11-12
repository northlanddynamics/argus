import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { useRouteContext } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Time } from "@/components/time";
import { AppHeader } from "@/components/app-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";

const organizationsKey = ["operator", "organizations"];

export function OperatorConsolePage() {
  const { me } = useRouteContext({ from: "/operator" });
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const organizations = useQuery({
    queryKey: organizationsKey,
    queryFn: async () => (await api.operator.organizations.$get()).json(),
  });

  const create = useMutation({
    mutationFn: async (json: { name: string; ownerEmail: string }) => {
      const res = await api.operator.organizations.$post({ json });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not create the Organization"));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: organizationsKey }),
  });

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setError(null);
    try {
      await create.mutateAsync({ name: String(form.get("name")), ownerEmail: String(form.get("ownerEmail")) });
      formEl.reset();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="min-h-svh bg-muted">
      <AppHeader email={me.user.email} badge={<span className="rounded-4xl border border-console-foreground/40 px-2 py-0.5 text-xs font-medium">Operator console</span>} />
      <main className="grid gap-4 p-6">
        <PageHeader title="Operator console" description="Every Organization on this Argus, and creating new ones." />
        <div className="grid items-start gap-4 lg:grid-cols-[1fr_320px]">
          <Card>
            <CardHeader>
              <CardTitle>Organizations</CardTitle>
            </CardHeader>
            <CardContent className="@container">
              <Table className="@xl:table-fixed">
                {/* Once there's room, set widths, a share of the table never below a minimum; the Organization takes the rest. */}
                <colgroup>
                  <col />
                  <col className="@xl:w-48 @7xl:w-[15%]" />
                  <col className="@xl:w-24 @7xl:w-[7.5%]" />
                  <col className="@xl:w-32 @7xl:w-[10%]" />
                </colgroup>
                <TableHeader>
                  <TableRow variant="static">
                    <TableHead>Organization</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead className="text-right">Members</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizations.data?.organizations.map((org) => (
                    <TableRow key={org.id}>
                      <TableCell className="font-medium">{org.name}</TableCell>
                      <TableCell>
                        <div className="truncate">{org.owner?.email ?? <span className="text-muted-foreground">—</span>}</div>
                        <div className="text-xs text-muted-foreground">
                          {org.owner?.status === "active" ? "Active" : org.owner ? "Invite pending" : ""}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{org.members}</TableCell>
                      <TableCell className="text-muted-foreground">
                        <Time iso={org.createdAt} />
                      </TableCell>
                    </TableRow>
                  ))}
                  {organizations.data?.organizations.length === 0 && (
                    <TableRow variant="static">
                      <TableCell colSpan={4} className="text-muted-foreground">
                        No Organizations yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Create Organization</CardTitle>
              <CardDescription>
                The Owner gets an email invite and sets a password.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4" onSubmit={onSubmit}>
                <div className="grid gap-2">
                  <Label htmlFor="name">Organization name</Label>
                  <Input id="name" name="name" required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ownerEmail">Owner email</Label>
                  <Input id="ownerEmail" name="ownerEmail" type="email" required />
                </div>
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" disabled={create.isPending}>
                  Create and invite Owner
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
