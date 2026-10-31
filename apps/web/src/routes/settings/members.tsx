import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, authClient, errorMessage } from "@/lib/api";
import { roleLabel } from "@/lib/roles";

export const membersKey = ["organization", "members"];

type Assignable = "admin" | "analyst";

/** Throws the API's error message unless `res` is OK. */
async function ok(res: Response, fallback: string) {
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
}

const signInMethods = (s: { password: boolean; totp: boolean; passkeys: number }) =>
  [s.password && (s.totp ? "Password + TOTP" : "Password"), s.passkeys > 0 && "passkey"].filter(Boolean).join(", ") || "—";

const lastActive = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

/** A change to the Members list: refreshes it afterwards and reports its error, if any. */
function useMembersAction<T>(setError: (error: string | null) => void, fn: (input: T) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onMutate: () => setError(null),
    onError: (e) => setError(e.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: membersKey }),
  });
}

export function MembersPage() {
  const { me } = useRouteContext({ from: "/settings" });
  const [error, setError] = useState<string | null>(null);
  const members = useQuery({
    queryKey: membersKey,
    queryFn: async () => (await api.organization.members.$get()).json(),
  });

  const invite = useMembersAction(setError, async (json: { email: string; role: Assignable }) =>
    ok(await api.organization.invitations.$post({ json }), "Could not send the invite"),
  );
  const revoke = useMembersAction(setError, async (id: string) =>
    ok(await api.organization.invitations[":id"].$delete({ param: { id } }), "Could not revoke the invite"),
  );
  const changeRole = useMembersAction(setError, async ({ id, role }: { id: string; role: Assignable }) =>
    ok(await api.organization.members[":id"].$patch({ param: { id }, json: { role } }), "Could not change the role"),
  );
  const remove = useMembersAction(setError, async (id: string) =>
    ok(await api.organization.members[":id"].$delete({ param: { id } }), "Could not remove the Member"),
  );

  const onInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    await invite.mutateAsync({ email: String(form.get("email")), role: form.get("role") as Assignable }).then(
      () => formEl.reset(),
      () => {},
    );
  };

  const list = members.data;
  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Members</CardTitle>
          <CardDescription>One Owner · Admins and Analysts</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form className="grid items-end gap-2 sm:grid-cols-[1fr_auto_auto]" onSubmit={onInvite}>
            <div className="grid gap-2">
              <Label htmlFor="invite-email">Invite by email</Label>
              <Input id="invite-email" name="email" type="email" required placeholder="name@example.com" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-role">Role</Label>
              <NativeSelect id="invite-role" name="role" defaultValue="analyst">
                <NativeSelectOption value="analyst">Analyst</NativeSelectOption>
                <NativeSelectOption value="admin">Admin</NativeSelectOption>
              </NativeSelect>
            </div>
            <Button type="submit" disabled={invite.isPending}>
              Send invite
            </Button>
          </form>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Sign-in</TableHead>
                <TableHead>Last active</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list?.members.map((m) => (
                <TableRow key={m.id} data-testid={`member-${m.email}`}>
                  <TableCell>
                    <div className="font-medium">{m.name}</div>
                    <div className="text-xs text-muted-foreground">{m.email}</div>
                  </TableCell>
                  <TableCell>
                    {m.role === "owner" ? (
                      <Badge>Owner</Badge>
                    ) : (
                      <NativeSelect
                        aria-label={`Role of ${m.name}`}
                        value={m.role}
                        disabled={changeRole.isPending}
                        onChange={(e) => changeRole.mutate({ id: m.id, role: e.target.value as Assignable })}
                      >
                        <NativeSelectOption value="admin">Admin</NativeSelectOption>
                        <NativeSelectOption value="analyst">Analyst</NativeSelectOption>
                      </NativeSelect>
                    )}
                  </TableCell>
                  <TableCell>{signInMethods(m.signIn)}</TableCell>
                  <TableCell className="text-muted-foreground">{lastActive(m.lastActiveAt)}</TableCell>
                  <TableCell className="text-right">
                    {m.role !== "owner" && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Remove ${m.name}`}
                        onClick={() => {
                          if (window.confirm(`Remove ${m.name} from ${me.organization?.name}?`)) remove.mutate(m.id);
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {list?.invitations?.map((i) => (
                <TableRow key={i.id} data-testid={`invitation-${i.email}`}>
                  <TableCell>
                    <div className="font-medium">{i.email}</div>
                    <div className="text-xs text-muted-foreground">Invited · {i.expired ? "expired" : "pending"}</div>
                  </TableCell>
                  <TableCell>{roleLabel[i.role]}</TableCell>
                  <TableCell>—</TableCell>
                  <TableCell>—</TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" aria-label={`Revoke invite for ${i.email}`} onClick={() => revoke.mutate(i.id)}>
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {me.organization?.role === "owner" && list && <OwnershipCard members={list.members} />}
    </>
  );
}

function OwnershipCard({ members }: { members: { id: string; name: string; email: string; role: string }[] }) {
  const { me } = useRouteContext({ from: "/settings" });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const organizationName = me.organization?.name ?? "";

  const transfer = useMutation({
    mutationFn: async (memberId: string) =>
      ok(await api.organization.ownership.$post({ json: { memberId } }), "Could not transfer ownership"),
    onMutate: () => setError(null),
    onError: (e) => setError(e.message),
    // The former Owner is now an Admin.
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const deleteOrganization = useMutation({
    mutationFn: async (confirmName: string) =>
      ok(await api.organization.$delete({ json: { confirmName } }), "Could not delete the Organization"),
    onMutate: () => setError(null),
    onError: (e) => setError(e.message),
    onSuccess: async () => {
      await authClient.signOut().catch(() => {});
      queryClient.clear();
      await navigate({ to: "/sign-in" });
    },
  });

  const onTransfer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const memberId = String(new FormData(event.currentTarget).get("memberId"));
    const to = members.find((m) => m.id === memberId);
    if (to && window.confirm(`Make ${to.name} the Owner of ${organizationName}? You will become an Admin.`)) {
      transfer.mutate(memberId);
    }
  };
  const onDelete = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    deleteOrganization.mutate(String(new FormData(event.currentTarget).get("confirmName")));
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Ownership</CardTitle>
        <CardDescription>Owner only</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <form className="grid items-end gap-2 sm:grid-cols-[1fr_auto]" onSubmit={onTransfer}>
          <div className="grid gap-2">
            <Label htmlFor="transfer-to">Transfer ownership to</Label>
            <NativeSelect id="transfer-to" name="memberId" required defaultValue="">
              <NativeSelectOption value="" disabled>
                Choose a Member…
              </NativeSelectOption>
              {members
                .filter((m) => m.role !== "owner")
                .map((m) => (
                  <NativeSelectOption key={m.id} value={m.id}>
                    {m.name} ({m.email})
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </div>
          <Button type="submit" variant="outline" disabled={transfer.isPending}>
            Transfer
          </Button>
        </form>
        <form className="grid items-end gap-2 sm:grid-cols-[1fr_auto]" onSubmit={onDelete}>
          <div className="grid gap-2">
            <Label htmlFor="confirm-name">Type {organizationName} to delete the Organization</Label>
            <Input id="confirm-name" name="confirmName" autoComplete="off" required />
          </div>
          <Button type="submit" variant="destructive" disabled={deleteOrganization.isPending}>
            Delete Organization…
          </Button>
        </form>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
