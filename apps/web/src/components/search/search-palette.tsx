import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { ArrowRightIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { KindFilter } from "@/components/search/kind-filter";
import { SearchHitRow, useOpenHit } from "@/components/search/search-hit";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useMe } from "@/lib/api";
import { hitKey, type SearchKind, searchKindLabel, searchQuery } from "@/lib/search";

/** How many results the search box shows before "See all results". */
const TOP = 5;

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Global search, from anywhere: the box in the header (or "/", or ⌘K / Ctrl+K) opens a palette that
 * searches as you type and shows the best five results across Cases, Alerts, Observables and Assets.
 * Toggles narrow it to some kinds; Enter opens the highlighted result, and the last row opens every
 * result on the results page, with the same toggles.
 */
export function SearchPalette() {
  const me = useMe(useRouteContext({ from: "/_app" }).me);
  const guest = !!me.guest;
  const navigate = useNavigate();
  const openHit = useOpenHit(guest);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [kinds, setKinds] = useState<SearchKind[]>([]);
  const settled = useDebounced(q, 150);
  const results = useQuery({ ...searchQuery({ q: settled, kinds, pageSize: TOP }), enabled: open && settled.trim().length > 0 });
  const hits = results.data && settled.trim() ? results.data.hits : [];
  const total = results.data && settled.trim() ? results.data.total : 0;
  // The highlight starts on the best result whenever the results change.
  const hitsKey = hits.map(hitKey).join("|");
  const [highlight, setHighlight] = useState({ for: "", value: "" });
  const highlighted = highlight.for === hitsKey ? highlight.value : ((hits[0] ? hitKey(hits[0]) : "see-all"));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const palette = (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target);
      if (!palette && !slash) return;
      e.preventDefault();
      setOpen((was) => (palette ? !was : true));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const seeAll = () => {
    setOpen(false);
    void navigate({ to: "/search", search: { q: q.trim(), kinds: kinds.length ? kinds.join(",") : undefined } });
  };
  const scope = kinds.length ? kinds.map((k) => searchKindLabel[k]).join(", ") : "Cases, Alerts, Observables and Assets";
  const typed = q.trim().length > 0;
  const waiting = typed && (settled !== q || results.isFetching) && !hits.length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search"
        className="flex h-8 items-center gap-2 rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted md:w-64"
      >
        <SearchIcon className="size-4" />
        <span className="hidden flex-1 text-left md:inline">Search…</span>
        <Kbd className="hidden md:inline-flex">/</Kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="top-[12%] translate-y-0 gap-0 overflow-hidden rounded-xl p-0 sm:max-w-xl">
          <DialogTitle className="sr-only">Search</DialogTitle>
          <DialogDescription className="sr-only">Search {scope}</DialogDescription>
          <Command
            shouldFilter={false}
            loop
            value={highlighted}
            onValueChange={(value) => setHighlight({ for: hitsKey, value })}
            className="rounded-none! p-0"
          >
            <div className="border-b p-2">
              <CommandInput
                value={q}
                onValueChange={setQ}
                placeholder={guest ? "Search your Cases…" : "Search Cases, Alerts, Observables, Assets…"}
                aria-label="Search"
                maxLength={200}
                className="h-9 text-base sm:text-sm"
              />
              <KindFilter kinds={kinds} onChange={setKinds} className="mt-2 flex-wrap" />
            </div>
            <CommandList className="max-h-[min(24rem,60vh)] p-1">
              {!typed && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Search {scope}. Try a title, host, IP, hash or “C-12”.</p>}
              {waiting && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Searching…</p>}
              {typed && !waiting && results.isError && <p className="px-3 py-6 text-center text-sm text-destructive">Could not search. Try again.</p>}
              {typed && !waiting && results.data && !hits.length && (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches “{q.trim()}”.</p>
              )}
              {hits.length > 0 && (
                <CommandGroup heading="Top results">
                  {hits.map((hit) => (
                    <CommandItem
                      key={hitKey(hit)}
                      value={hitKey(hit)}
                      onSelect={() => {
                        setOpen(false);
                        void openHit(hit);
                      }}
                      className="py-1.5 [&>svg:last-child]:hidden"
                    >
                      <SearchHitRow hit={hit} query={settled} showKind />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {typed && (
                <CommandItem value="see-all" onSelect={seeAll} className="mt-1 justify-between border-t py-2 text-muted-foreground [&>svg:last-child]:hidden">
                  <span>
                    See all {total > hits.length ? `${total} ` : ""}results for <span className="text-foreground">“{q.trim()}”</span>
                  </span>
                  <ArrowRightIcon className="size-4" />
                </CommandItem>
              )}
            </CommandList>
            <div className="hidden items-center gap-3 border-t px-3 py-2 text-xs text-muted-foreground sm:flex">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> to move
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> to open
              </span>
              <span className="flex items-center gap-1">
                <Kbd>esc</Kbd> to close
              </span>
              <span className="ml-auto">"quotes" for a phrase · -word to leave out</span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
