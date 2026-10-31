import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AuthCard } from "@/components/sign-in/auth-card";
import { ErrorAlert } from "@/components/sign-in/error-alert";
import { TotpChallenge } from "@/components/sign-in/totp-challenge";
import { TotpEnrollment } from "@/components/sign-in/totp-enrollment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { api, authClient } from "@/lib/api";

type Step = { kind: "credentials" } | { kind: "totp" } | { kind: "enroll"; password: string };

export function SignInPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const enterArgus = async () => {
    await queryClient.invalidateQueries();
    await navigate({ to: "/" });
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    setPending(true);
    setError(null);
    const result = await authClient.signIn.email({ email: String(form.get("email")), password });
    if (result.error) {
      setPending(false);
      setError(result.error.message ?? "Sign-in failed");
      return;
    }
    if ("twoFactorRedirect" in result.data && result.data.twoFactorRedirect) {
      setPending(false);
      setStep({ kind: "totp" });
      return;
    }
    // Signed in by password alone: a Member who hasn't enrolled in TOTP must do so now.
    const me = await api.me.$get();
    setPending(false);
    if (me.status === 403) setStep({ kind: "enroll", password });
    else await enterArgus();
  };

  const signInWithPasskey = async () => {
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result?.error) {
      setError(result.error.message ?? "Passkey sign-in failed");
      return;
    }
    await enterArgus();
  };

  if (step.kind === "totp") return <TotpChallenge onSignedIn={enterArgus} />;
  if (step.kind === "enroll") return <TotpEnrollment password={step.password} onDone={enterArgus} />;

  return (
    <AuthCard title="Sign in">
      <form className="grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-2">
          <Label htmlFor="email">Work email</Label>
          <Input id="email" name="email" type="email" autoComplete="username webauthn" required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <ErrorAlert error={error} />
        <Button type="submit" disabled={pending}>
          Continue
        </Button>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Separator className="flex-1" />
          or
          <Separator className="flex-1" />
        </div>
        <Button type="button" variant="outline" onClick={signInWithPasskey}>
          Sign in with a passkey
        </Button>
        <p className="text-sm text-muted-foreground">No self-serve sign-up. Ask your Organization's Admin for an invite.</p>
      </form>
    </AuthCard>
  );
}
