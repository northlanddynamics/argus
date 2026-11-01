import { useEffect, useState } from "react";
import { type GuestInfo, timeLeft } from "@/lib/guests";

/** For Guests: that they're a Guest, and when their session ends. */
export function GuestSession({ guest }: { guest: GuestInfo }) {
  // Counted on the server's clock, which the browser's may not agree with.
  const [skew] = useState(() => Date.parse(guest.asOf) - Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="rounded-full border px-2 py-0.5 text-foreground">Guest access</span>
      <span className="hidden sm:inline">Session ends in {timeLeft(guest.sessionEndsAt, now + skew)}</span>
    </div>
  );
}
