import { Link, Outlet } from "@tanstack/react-router";

const sideLink =
  "rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground data-[status=active]:bg-muted data-[status=active]:text-foreground data-[status=active]:font-medium";

/** Organization settings, for Admins and the Owner. */
export function SettingsLayout() {
  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
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
      <div className="grid min-w-0 content-start gap-4">
        <Outlet />
      </div>
    </div>
  );
}
