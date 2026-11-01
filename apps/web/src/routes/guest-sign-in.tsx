import { useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AuthCard } from "@/components/sign-in/auth-card";
import { ErrorAlert } from "@/components/sign-in/error-alert";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/api";

export type GuestSignInSearch = { email?: string; error?: string };

export const validateGuestSignInSearch = (search: Record<string, unknown>): GuestSignInSearch => ({
  email: typeof search.email === "string" ? search.email : undefined,
  error: typeof search.error === "string" ? search.error : undefined,
});

/** `/guest/sign-in`: a Guest asks for a magic link. Followed, it signs them in and lands on `/`. */
export function GuestSignInPage() {
  const search = useSearch({ from: "/guest/sign-in" });
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    search.error ? "That sign-in link has expired or was already used. Ask for a new one." : null,
  );
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email"));
    setPending(true);
    setError(null);
    const result = await authClient.signIn.magicLink({ email, callbackURL: "/", errorCallbackURL: "/guest/sign-in" });
    setPending(false);
    if (result.error) setError(result.error.message ?? "Could not send a sign-in link");
    else setSentTo(email);
  };

  return (
    <AuthCard title="Guest sign-in" description="You were invited to a Case. We'll email you a one-time link.">
      <form className="grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-2">
          <Label htmlFor="guest-email">Email</Label>
          <Input id="guest-email" name="email" type="email" autoComplete="email" defaultValue={search.email} required />
        </div>
        <ErrorAlert error={error} />
        {sentTo && (
          <Alert>
            <AlertDescription>
              If {sentTo} has been invited to a Case, a sign-in link is on its way. Check your inbox. The link signs you in for
              about 12 hours.
            </AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={pending}>
          Email me a sign-in link
        </Button>
        <p className="text-sm text-muted-foreground">
          Access ends when your expiry passes or you are removed from your last Case.
        </p>
      </form>
    </AuthCard>
  );
}
