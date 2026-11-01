import { useRouteContext } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { useMe } from "@/lib/api";
import { caseRef } from "@/lib/cases";
import { expiryLabel, type GuestInfo, useOpenGuestCase } from "@/lib/guests";
import { CasesPage } from "@/routes/cases/list";

/** `/`: the Case list for Members, a Guest's Cases for Guests. */
export function HomePage() {
  const me = useMe(useRouteContext({ from: "/_app/" }).me);
  return me.guest ? <GuestHomePage guest={me.guest} /> : <CasesPage />;
}

/** Every Case a Guest is invited to, across the Organizations that invited them. */
function GuestHomePage({ guest }: { guest: GuestInfo }) {
  const openCase = useOpenGuestCase(guest);
  const [error, setError] = useState<string | null>(null);
  const organizations = new Set(guest.cases.map((c) => c.organization.id)).size;
  return (
    <div className="mx-auto grid w-full grid-cols-1 max-w-3xl gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Your Cases</h1>
      <Card>
        <CardContent className="grid gap-3">
          {guest.cases.length ? (
            <ul className="grid gap-1">
              {guest.cases.map((c) => (
                <li key={`${c.organization.id}:${c.number}`}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-baseline gap-x-2 rounded-md px-3 py-2 text-left hover:bg-muted"
                    onClick={() => openCase(c).catch((e: Error) => setError(e.message))}
                  >
                    <span className="font-mono text-sm">{caseRef(c.number)}</span>
                    <span className="font-medium text-primary underline">{c.title}</span>
                    <span className="text-sm text-muted-foreground">
                      [{c.organization.name}] · {expiryLabel(c.expiresAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">You no longer have access to any Cases.</p>
          )}
          {organizations > 1 && (
            <p className="text-xs text-muted-foreground">One Guest account, invited by {organizations} Organizations.</p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
