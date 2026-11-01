import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { type GuestInfo, timeLeft } from "@/lib/guests";

const linkClass = "text-slate-300 hover:text-slate-50 data-[status=active]:text-slate-50 data-[status=active]:underline underline-offset-8";

/** Top navigation for Guests: where they are, their Cases, and when their session ends. */
export function GuestNav({ guest }: { guest: GuestInfo }) {
  // Counted on the server's clock, which the browser's may not agree with.
  const [skew] = useState(() => Date.parse(guest.asOf) - Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <nav className="flex items-center gap-4 text-sm">
      <span className="rounded-full border border-slate-500 px-2 py-0.5 text-xs text-slate-200">Guest access</span>
      {guest.organization && <span className="text-slate-400">{guest.organization.name}</span>}
      <Link to="/" className={linkClass} activeOptions={{ exact: true }}>
        Your Cases
      </Link>
      <span className="text-slate-400">Session ends in {timeLeft(guest.sessionEndsAt, now + skew)}</span>
    </nav>
  );
}
