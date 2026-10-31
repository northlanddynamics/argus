import { useRouteContext } from "@tanstack/react-router";
import { AppHeader } from "@/components/app-header";
import { OrgNav } from "@/components/org-nav";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function OrganizationHomePage() {
  const { me } = useRouteContext({ from: "/" });
  return (
    <div className="min-h-svh bg-muted">
      <AppHeader email={me.user.email} badge={<OrgNav me={me} />} />
      <main className="mx-auto max-w-5xl p-6">
        <h1 className="mb-6 text-2xl font-semibold">{me.organization?.name ?? "No Organization"}</h1>
        <Card>
          <CardHeader>
            <CardTitle>No Cases yet</CardTitle>
            <CardDescription>
              Cases your team opens will appear here.
            </CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      </main>
    </div>
  );
}
