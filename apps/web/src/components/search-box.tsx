import { useNavigate, useSearch } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

/** The global search box in the header: Enter opens the results; "/" anywhere focuses it. */
export function SearchBox() {
  const navigate = useNavigate();
  const current = useSearch({ strict: false }) as { q?: unknown };
  const [q, setQ] = useState(typeof current.q === "string" ? current.q : "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, []);
  return (
    <form
      role="search"
      className="relative w-full max-w-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) void navigate({ to: "/search", search: { q: q.trim() } });
      }}
    >
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={input}
        type="search"
        aria-label="Search Cases, Alerts, Observables and Assets"
        placeholder="Search…"
        className="h-8 pl-8"
        value={q}
        maxLength={200}
        onChange={(e) => setQ(e.target.value)}
      />
    </form>
  );
}
