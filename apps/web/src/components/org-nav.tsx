import { Link } from "@tanstack/react-router";
import type { Me } from "@/lib/api";
import { canManage } from "@/lib/roles";

const linkClass = "text-slate-300 hover:text-slate-50 data-[status=active]:text-slate-50 data-[status=active]:underline underline-offset-8";

/** Top navigation for Members. */
export function OrgNav({ me }: { me: Me }) {
  return (
    <nav className="flex items-center gap-4 text-sm">
      <span className="text-slate-400">{me.organization?.name}</span>
      <Link to="/" className={linkClass} activeOptions={{ exact: true }}>
        Cases
      </Link>
      {canManage(me.organization?.role) && (
        <Link to="/settings" className={linkClass}>
          Settings
        </Link>
      )}
    </nav>
  );
}
