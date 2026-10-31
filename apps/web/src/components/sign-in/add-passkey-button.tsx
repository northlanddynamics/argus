import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/api";

/** Registers a passkey for the signed-in person through the browser's WebAuthn prompt. */
export function AddPasskeyButton({ label = "Add a passkey", ...props }: { label?: string } & Omit<
  React.ComponentProps<typeof Button>,
  "onClick" | "children"
>) {
  const [state, setState] = useState<"idle" | "pending" | "added" | "failed">("idle");
  const add = async () => {
    setState("pending");
    const result = await authClient.passkey.addPasskey();
    setState(result?.error ? "failed" : "added");
  };
  return (
    <Button variant="outline" {...props} onClick={add} disabled={state === "pending" || state === "added"}>
      {state === "added" ? "Passkey added" : state === "failed" ? "Passkey not added, try again" : label}
    </Button>
  );
}
