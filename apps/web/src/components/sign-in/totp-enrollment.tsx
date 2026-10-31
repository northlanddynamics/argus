import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/api";
import { AuthCard } from "./auth-card";
import { ErrorAlert } from "./error-alert";
import { AddPasskeyButton } from "./add-passkey-button";

/**
 * Forced TOTP enrollment for a Member who signed in with a password and has no TOTP yet.
 * `password` is the one they just typed: Better Auth asks for it again to enable TOTP.
 */
export function TotpEnrollment({ password, onDone }: { password: string; onDone: () => Promise<void> }) {
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // A query (not an effect) so React's double-mount in development doesn't enable twice and swap the secret.
  const setup = useQuery({
    queryKey: ["totp-enrollment"],
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const result = await authClient.twoFactor.enable({ password });
      if (result.error || result.data.method !== "totp") {
        throw new Error(result.error?.message ?? "Could not start two-factor setup");
      }
      return result.data;
    },
  });

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!setup.data) return;
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    setPending(true);
    setError(null);
    const result = await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "That code didn't work");
      return;
    }
    setBackupCodes(setup.data.backupCodes);
  };

  if (backupCodes) {
    return (
      <AuthCard
        title="Save your backup codes"
        description="Each code signs you in once if you lose your authenticator app. Store them somewhere safe; they won't be shown again."
      >
        <div className="grid gap-4">
          <ul aria-label="Backup codes" className="grid grid-cols-2 gap-2 rounded-md bg-muted p-3 font-mono text-sm">
            {backupCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <Button onClick={onDone}>Continue to Argus</Button>
          <AddPasskeyButton label="Also add a passkey" />
        </div>
      </AuthCard>
    );
  }

  const key = setup.data ? (new URL(setup.data.totpURI).searchParams.get("secret") ?? "") : "";
  return (
    <AuthCard
      title="Set up two-factor authentication"
      description="Required before you can use Argus with a password."
    >
      {setup.isError ? (
        <ErrorAlert error={setup.error.message} />
      ) : (
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid justify-items-center gap-3">
            <div className="rounded-md bg-white p-3">
              {setup.data ? (
                <QRCodeSVG value={setup.data.totpURI} size={160} title="Authenticator app QR code" />
              ) : (
                <div className="size-40" aria-hidden />
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Scan with your authenticator app, or enter the key:{" "}
              <code data-testid="totp-key" className="break-all font-mono text-foreground">
                {key.match(/.{1,4}/g)?.join(" ")}
              </code>
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="code">Code from app</Label>
            <Input
              id="code"
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </div>
          <ErrorAlert error={error} />
          <Button type="submit" disabled={pending || !setup.data}>
            Confirm and continue
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
