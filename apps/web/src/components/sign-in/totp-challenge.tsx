import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/api";
import { AuthCard } from "./auth-card";
import { ErrorAlert } from "./error-alert";

/** Second step of password sign-in for a Member enrolled in TOTP. */
export function TotpChallenge({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    setPending(true);
    setError(null);
    const result = useBackupCode
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "That code didn't work");
      return;
    }
    await onSignedIn();
  };

  return (
    <AuthCard
      title={useBackupCode ? "Enter a backup code" : "Enter your 6-digit code"}
      description={
        useBackupCode
          ? "One of the backup codes you saved when you set up two-factor authentication. Each works once."
          : "From your authenticator app. Password sign-in never completes without it."
      }
    >
      <form className="grid gap-4" onSubmit={onSubmit} key={useBackupCode ? "backup" : "totp"}>
        <div className="grid gap-2">
          <Label htmlFor="code">{useBackupCode ? "Backup code" : "Authentication code"}</Label>
          <Input
            id="code"
            name="code"
            autoComplete="one-time-code"
            inputMode={useBackupCode ? "text" : "numeric"}
            pattern={useBackupCode ? undefined : "[0-9]{6}"}
            maxLength={useBackupCode ? 32 : 6}
            autoFocus
            required
          />
        </div>
        <ErrorAlert error={error} />
        <Button type="submit" disabled={pending}>
          Verify
        </Button>
        <button
          type="button"
          className="justify-self-start text-sm underline underline-offset-4"
          onClick={() => {
            setUseBackupCode(!useBackupCode);
            setError(null);
          }}
        >
          {useBackupCode ? "Use your authenticator app" : "Use a backup code"}
        </button>
      </form>
    </AuthCard>
  );
}
