import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LiveIndicator } from "@/components/live-indicator";
import { AddPasskeyButton } from "@/components/sign-in/add-passkey-button";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/api";

/** With `live`, holds the live connection open and shows its state. Guests have no passkeys to add. */
export function AppHeader({
  badge,
  email,
  live = false,
  passkeys = true,
}: {
  badge?: ReactNode;
  email: string;
  live?: boolean;
  passkeys?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: "/sign-in" });
  };
  return (
    <header className="flex items-center justify-between bg-slate-900 px-6 py-3 text-slate-50">
      <div className="flex items-center gap-4">
        <span className="font-semibold tracking-widest">ARGUS</span>
        {badge}
      </div>
      <div className="flex items-center gap-4 text-sm">
        {live && <LiveIndicator />}
        <span>{email}</span>
        {passkeys && <AddPasskeyButton size="sm" className="bg-transparent text-slate-50" />}
        <Button variant="secondary" size="sm" onClick={signOut}>
          Sign out
        </Button>
      </div>
    </header>
  );
}
