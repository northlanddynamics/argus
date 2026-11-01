import { Link, Outlet, useRouteContext } from "@tanstack/react-router";
import { AppHeader } from "@/components/app-header";
import { OrgNav } from "@/components/org-nav";

const sideLink =
  "rounded-md px-3 py-2 text-sm hover:bg-background/60 data-[status=active]:bg-background data-[status=active]:font-medium";

/** Organization settings, for Admins and the Owner. */
export function SettingsLayout() {
  const { me } = useRouteContext({ from: "/settings" });
  return (
    <div className="min-h-svh bg-muted">
      <AppHeader email={me.user.email} badge={<OrgNav me={me} />} />
      <div className="mx-auto grid max-w-6xl gap-6 p-6 md:grid-cols-[200px_1fr]">
        <nav className="grid content-start gap-1" aria-label="Organization settings">
          <p className="px-3 pb-2 text-xs text-muted-foreground">Organization settings · Admins</p>
          <Link to="/settings/members" className={sideLink}>
            Members
          </Link>
          <Link to="/settings/integrations" className={sideLink}>
            Integrations
          </Link>
          <Link to="/settings/audit-log" className={sideLink}>
            Organization Audit Log
          </Link>
        </nav>
        <main className="grid min-w-0 content-start gap-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
