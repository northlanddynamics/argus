import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext, useSearch } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useState } from "react";
import { KindFilter } from "@/components/search/kind-filter";
import { SearchHitLink, SearchHitRow } from "@/components/search/search-hit";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { useMe } from "@/lib/api";
import { hitsOf, parseKinds, SEARCH_KINDS, type SearchKind, searchKindLabel, searchQuery } from "@/lib/search";

/** Results of each kind the page shows. */
const LIMIT = 50;

/**
 * Every result of a search, grouped by kind in the same compact rows and with the same kind
 * toggles as the search box. The query and kinds live in the URL, so a search can be shared.
 */
export function SearchPage() {
  const search = useSearch({ from: "/_app/search" });
  const navigate = useNavigate({ from: "/search" });
  const me = useMe(useRouteContext({ from: "/_app" }).me);
  const guest = !!me.guest;
  const q = search.q ?? "";
  const kinds = parseKinds(search.kinds);
  const setSearch = (next: { q?: string; kinds?: SearchKind[] }) =>
    navigate({
      search: (prev) => {
        const nextKinds = next.kinds ?? parseKinds(prev.kinds);
        return { q: (next.q ?? prev.q) || undefined, kinds: nextKinds.length ? nextKinds.join(",") : undefined };
      },
      replace: true,
    });

  // Every kind is counted, so the toggles say what each holds even while some are off.
  const results = useQuery(searchQuery({ q, kinds: [], limit: LIMIT }));
  const data = results.data;
  const shown = (kinds.length ? kinds : SEARCH_KINDS).filter((k) => data && hitsOf(data, k).length);
  const counts = data
    ? Object.fromEntries(SEARCH_KINDS.map((k) => [k, `${hitsOf(data, k).length}${data.more[k] ? "+" : ""}`]))
    : undefined;
  const total = shown.reduce((n, k) => n + (data ? hitsOf(data, k).length : 0), 0);

  return (
    <div className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
      <SearchForm key={q} initial={q} guest={guest} onSearch={(next) => void setSearch({ q: next })} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <KindFilter kinds={kinds} onChange={(next) => void setSearch({ kinds: next })} counts={q ? counts : undefined} className="flex-wrap" />
        <p className="text-xs text-muted-foreground">"quotes" for a phrase · -word to leave out</p>
      </div>

      {!q && <p className="py-8 text-center text-sm text-muted-foreground">Type what you're looking for and press Enter.</p>}
      {q && results.isError && <p className="py-8 text-center text-sm text-destructive">Could not search. Try again.</p>}
      {q && results.isPending && (
        <div className="grid grid-cols-1 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-11" />
          ))}
        </div>
      )}
      {q && data && !total && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Nothing {kinds.length ? `in ${kinds.map((k) => searchKindLabel[k]).join(", ")} ` : ""}matches “{q}”.
        </p>
      )}

      {data && total > 0 && (
        <div className={results.isPlaceholderData ? "grid grid-cols-1 gap-6 opacity-60 transition-opacity" : "grid grid-cols-1 gap-6"}>
          {shown.map((kind) => {
            const hits = hitsOf(data, kind);
            return (
              <section key={kind} aria-labelledby={`results-${kind}`}>
                <h2 id={`results-${kind}`} className="mb-1 flex items-baseline gap-2 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {searchKindLabel[kind]}
                  <span className="tabular-nums">{counts?.[kind]}</span>
                </h2>
                <ul className="divide-y rounded-lg border">
                  {hits.map((hit) => (
                    <li key={hit.key}>
                      <SearchHitLink hit={hit} guest={guest} className="rounded-none px-3 py-2">
                        <SearchHitRow hit={hit} query={q} />
                      </SearchHitLink>
                    </li>
                  ))}
                </ul>
                {data.more[kind] && (
                  <p className="mt-1 px-2 text-xs text-muted-foreground">Showing the best {LIMIT}. Add words to narrow it down.</p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The page's own search field; it starts from the URL's query and searches on Enter. */
function SearchForm({ initial, guest, onSearch }: { initial: string; guest: boolean; onSearch: (q: string) => void }) {
  const [draft, setDraft] = useState(initial);
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(draft.trim());
      }}
    >
      <InputGroup className="h-10">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="Search"
          placeholder={guest ? "Search your Cases…" : "Search Cases, Alerts, Observables, Assets…"}
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
        />
      </InputGroup>
    </form>
  );
}
