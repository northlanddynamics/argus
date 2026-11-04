import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";
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

/** Where SSO sends people back when their identity provider's answer didn't get them in. */
export type SignInSearch = { error?: string; error_description?: string };

export const validateSignInSearch = (search: Record<string, unknown>): SignInSearch => ({
  error: typeof search.error === "string" ? search.error : undefined,
  error_description: typeof search.error_description === "string" ? search.error_description : undefined,
});

/** Why an SSO sign-in came back without a session, in words. */
const ssoError = ({ error, error_description }: SignInSearch) =>
  error ? (error_description ?? "Single sign-on didn't sign you in.").replace(/_/g, " ") : null;

export function SignInPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ from: "/sign-in" });
  const emailRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [error, setError] = useState<string | null>(ssoError(search));
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

  /** Sends the browser to the identity provider of the Organization that signs in the email's domain. */
  const signInWithSso = async () => {
    const email = emailRef.current?.value.trim() ?? "";
    if (!email || !emailRef.current?.checkValidity()) {
      setError("Enter your work email to sign in with SSO");
      return;
    }
    setError(null);
    setPending(true);
    const result = await authClient.$fetch<{ url: string }>("/sign-in/sso", {
      method: "POST",
      body: { email, callbackURL: "/", errorCallbackURL: "/sign-in" },
    });
    if (result.error) {
      setPending(false);
      setError(result.error.status === 404 ? "Single sign-on isn't set up for this email domain" : (result.error.message ?? "SSO sign-in failed"));
      return;
    }
    window.location.assign(result.data.url);
  };

  if (step.kind === "totp") return <TotpChallenge onSignedIn={enterArgus} />;
  if (step.kind === "enroll") return <TotpEnrollment password={step.password} onDone={enterArgus} />;

  return (
    <AuthCard title="Sign in">
      <form className="grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-2">
          <Label htmlFor="email">Work email</Label>
          <Input ref={emailRef} id="email" name="email" type="email" autoComplete="username webauthn" required />
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
        <Button type="button" variant="outline" disabled={pending} onClick={signInWithSso}>
          Sign in with SSO (SAML)
        </Button>
        <p className="text-sm text-muted-foreground">No self-serve sign-up. Ask your Organization's Admin for an invite.</p>
        <p className="text-sm text-muted-foreground">
          Invited to a Case as a Guest?{" "}
          <Link to="/guest/sign-in" className="text-primary underline">
            Sign in with an email link
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}
