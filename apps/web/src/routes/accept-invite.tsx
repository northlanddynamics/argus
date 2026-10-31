import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TotpEnrollment } from "@/components/sign-in/totp-enrollment";
import { api, authClient, errorMessage } from "@/lib/api";

export function AcceptInvitePage() {
  const { invitationId } = useParams({ from: "/invite/$invitationId" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set once the new account is signed in: next comes mandatory TOTP enrollment.
  const [enrollWith, setEnrollWith] = useState<string | null>(null);

  const invitation = useQuery({
    queryKey: ["invitation", invitationId],
    retry: false,
    queryFn: async () => {
      const res = await api.invitations[":id"].$get({ param: { id: invitationId } });
      if (!res.ok) throw new Error(await errorMessage(res, "Invitation not found"));
      return res.json();
    },
  });

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!invitation.data) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm"))) {
      setError("Passwords do not match");
      return;
    }
    setPending(true);
    setError(null);
    const res = await api.invitations[":id"].accept.$post({
      param: { id: invitationId },
      json: { name: String(form.get("name")), password },
    });
    if (!res.ok) {
      setPending(false);
      setError(await errorMessage(res, "Could not accept the invitation"));
      return;
    }
    const signIn = await authClient.signIn.email({ email: invitation.data.email, password });
    setPending(false);
    if (signIn.error) {
      setError(signIn.error.message ?? "Sign-in failed");
      return;
    }
    setEnrollWith(password);
  };

  if (enrollWith) {
    return (
      <TotpEnrollment
        password={enrollWith}
        onDone={async () => {
          await queryClient.invalidateQueries();
          await navigate({ to: "/" });
        }}
      />
    );
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <p className="text-sm font-semibold tracking-widest">ARGUS</p>
          <CardTitle className="text-2xl">Accept invitation</CardTitle>
          {invitation.data && (
            <CardDescription>
              You're invited to be the {invitation.data.role === "owner" ? "Owner" : "Member"} of{" "}
              <strong>{invitation.data.organization.name}</strong> as {invitation.data.email}.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {invitation.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{invitation.error.message}</AlertDescription>
            </Alert>
          ) : (
            <form className="grid gap-4" onSubmit={onSubmit}>
              <div className="grid gap-2">
                <Label htmlFor="name">Your name</Label>
                <Input id="name" name="name" autoComplete="name" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required />
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={pending || !invitation.data}>
                Set password and sign in
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
