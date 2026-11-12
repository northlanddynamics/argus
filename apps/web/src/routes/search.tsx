import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { Link, useNavigate, useRouteContext, useSearch } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import { KindFilter } from "@/components/search/kind-filter";
import { AccountHoverCard } from "@/components/account-details";
import { SearchHitLink, SearchHitRow } from "@/components/search/search-hit";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { useMe } from "@/lib/api";
import { hitKey, noMatchHint, parseKinds, SEARCH_KINDS, SEARCH_SYNTAX, type SearchKind, type SearchPageSearch, searchKindLabel, searchQuery } from "@/lib/search";

/** Results on a page. */
const PAGE_SIZE = 20;

/**
 * Every result of a search as one list, best first across kinds, a page at a time: the same compact
 * rows and kind toggles as the search box. With no query it lists everything, newest first. The
 * query, kinds and page live in the URL, so a search can be shared.
 */
export function SearchPage() {
  const search = useSearch({ from: "/_app/search" });
  const navigate = useNavigate({ from: "/search" });
  const me = useMe(useRouteContext({ from: "/_app" }).me);
  const guest = !!me.guest;
  const q = search.q ?? "";
  const kinds = parseKinds(search.kinds);
  const page = search.page ?? 1;
  /** A new query or new kinds start again from the first page. */
  const setSearch = (next: { q?: string; kinds?: SearchKind[] }) =>
    navigate({
      search: (prev) => {
        const nextKinds = next.kinds ?? parseKinds(prev.kinds);
        return { q: (next.q ?? prev.q) || undefined, kinds: nextKinds.length ? nextKinds.join(",") : undefined, page: undefined };
      },
      replace: true,
    });

  const results = useQuery(searchQuery({ q, kinds, page, pageSize: PAGE_SIZE }));
  const data = results.data;
  const counts = data ? Object.fromEntries(SEARCH_KINDS.map((k) => [k, String(data.counts[k])])) : undefined;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const first = (page - 1) * PAGE_SIZE + 1;
  const pageSearch = (p: number): SearchPageSearch => ({ ...search, page: p > 1 ? p : undefined });

  return (
    // Results read best first, top to bottom, so the page stays a reading column rather than filling a wide screen.
    <div className="grid w-full grid-cols-1 gap-4">
      <PageHeader title="Search" />
      <SearchForm key={q} initial={q} guest={guest} onSearch={(next) => void setSearch({ q: next })} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <KindFilter kinds={kinds} onChange={(next) => void setSearch({ kinds: next })} counts={counts} className="flex-wrap" />
        <p className="text-xs text-muted-foreground">{SEARCH_SYNTAX}</p>
      </div>

      {results.isError && (
        <p className="py-8 text-center text-sm">
          <span className="text-destructive">Could not search.</span>{" "}
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void results.refetch()}>
            Try again
          </Button>
        </p>
      )}
      {results.isPending && (
        <div className="grid grid-cols-1 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-11" />
          ))}
        </div>
      )}
      {!q && data && !data.total && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Nothing {kinds.length ? `in ${kinds.map((k) => searchKindLabel[k]).join(", ")} ` : ""}to show yet.
        </p>
      )}
      {q && data && !data.total && (
        <div className="grid gap-1 py-8 text-center text-sm">
          <p>
            Nothing {kinds.length ? `in ${kinds.map((k) => searchKindLabel[k]).join(", ")} ` : ""}matches “{q}”.
          </p>
          <p className="text-muted-foreground">
            {noMatchHint(q)}
            {kinds.length > 0 && Object.values(data.counts).some(Boolean) && (
              <>
                {" "}
                <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void setSearch({ kinds: [] })}>
                  Search every kind
                </Button>
              </>
            )}
          </p>
        </div>
      )}
      {data && data.total > 0 && !data.hits.length && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          There {pages === 1 ? "is only 1 page" : `are only ${pages} pages`} of results.{" "}
          <Link to="/search" search={pageSearch(1)} className="underline">
            Back to the first
          </Link>
        </p>
      )}

      {data && data.hits.length > 0 && (
        <div className={results.isPlaceholderData ? "grid grid-cols-1 gap-3 opacity-60 transition-opacity" : "grid grid-cols-1 gap-3"}>
          <p className="px-1 text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {data.total === 1 ? "1 result" : `${first}–${first + data.hits.length - 1} of ${data.total} results, ${q ? "best" : "newest"} first`}
          </p>
          <ul aria-label="Results" className="divide-y rounded-lg border">
            {data.hits.map((hit) => (
              <li key={hitKey(hit)}>
                <AccountHoverCard
                  assetId={hit.kind === "assets" ? hit.item.id : ""}
                  account={hit.kind === "assets" ? hit.item.value : ""}
                  enabled={hit.kind === "assets" && hit.item.type === "account"}
                >
                  <SearchHitLink hit={hit} guest={guest} className="rounded-none px-3 py-2">
                    <SearchHitRow hit={hit} query={q} showKind />
                  </SearchHitLink>
                </AccountHoverCard>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label="Pages" className="flex items-center justify-between gap-2">
              <PageLink to={pageSearch(page - 1)} disabled={page <= 1}>
                <ChevronLeftIcon /> Previous
              </PageLink>
              <span className="text-sm text-muted-foreground tabular-nums">
                Page {page} of {pages}
              </span>
              <PageLink to={pageSearch(page + 1)} disabled={page >= pages}>
                Next <ChevronRightIcon />
              </PageLink>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}

function PageLink({ to, disabled, children }: { to: SearchPageSearch; disabled: boolean; children: React.ReactNode }) {
  if (disabled) {
    return (
      <Button variant="outline" size="sm" disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" asChild>
      <Link to="/search" search={to}>
        {children}
      </Link>
    </Button>
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
