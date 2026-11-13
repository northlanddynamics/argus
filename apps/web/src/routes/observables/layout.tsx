import { Link, Outlet, useMatchRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ItemTypeIcon } from "@/components/item-value";
import { ASSET_TYPES, assetTypeLabel, OBSERVABLE_TYPES, observableTypeLabel, type ObservablesSearch, tickedTypes } from "@/lib/observables";

/** How long typing pauses before the search is put in the URL, and so run. */
const TYPING_MS = 250;

/**
 * The Observables page: the Observables tab lists every Observable the Organization holds; the
 * Ignored tab, its Ignored list. Both have their own URL, and share the search bar and the type
 * checkboxes in the left menu, which they keep in the URL so they carry between tabs. No box ticked
 * means every type. Members only.
 */
export function ObservablesLayout() {
  const matchRoute = useMatchRoute();
  const onIgnored = !!matchRoute({ to: "/observables/ignored" });
  const search: ObservablesSearch = useSearch({ from: "/_app/observables" });
  const navigate = useNavigate();
  const ticked = tickedTypes(search.types);
  const to = onIgnored ? "/observables/ignored" : "/observables";
  const update = (next: ObservablesSearch) => navigate({ to, search: (prev) => ({ ...prev, ...next }), replace: true });

  const setTicked = (type: string, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(type);
    else next.delete(type);
    update({ types: next.size ? [...next].join(",") : undefined });
  };

  return (
    <div className="grid w-full grid-cols-1 gap-4">
      <PageHeader title="Observables" description="Every Observable the Organization holds, and its Ignored list." />
      <Tabs value={onIgnored ? "ignored" : "observables"} activationMode="manual">
        <TabsList variant="line" aria-label="Observables" className="w-full justify-start">
          <TabsTrigger value="observables" className="h-8 flex-none" asChild>
            <Link to="/observables" search={(prev) => prev}>
              Observables
            </Link>
          </TabsTrigger>
          <TabsTrigger value="ignored" className="h-8 flex-none" asChild>
            <Link to="/observables/ignored" search={(prev) => prev}>
              Ignored
            </Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="grid w-full grid-cols-1 gap-6 @3xl:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="grid content-start gap-4" aria-label="Filter by type">
          <TypeGroup title="Observable types" types={OBSERVABLE_TYPES.map((t) => [t, observableTypeLabel[t]])} ticked={ticked} onTick={setTicked} />
          {onIgnored && <TypeGroup title="Asset types" types={ASSET_TYPES.map((t) => [t, assetTypeLabel[t]])} ticked={ticked} onTick={setTicked} />}
          {ticked.size > 0 && (
            <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => update({ types: undefined })}>
              Show every type
            </Button>
          )}
        </nav>
        <div className="grid min-w-0 content-start gap-4">
          <SearchBar initial={search.q ?? ""} onSearch={(q) => update({ q: q || undefined })} />
          <Outlet />
        </div>
      </div>
    </div>
  );
}

function TypeGroup({
  title,
  types,
  ticked,
  onTick,
}: {
  title: string;
  types: (readonly [string, string])[];
  ticked: Set<string>;
  onTick: (type: string, on: boolean) => void;
}) {
  const id = useId();
  return (
    <fieldset className="grid gap-1" aria-labelledby={id}>
      <legend id={id} className="px-3 pb-1 text-xs font-medium text-muted-foreground">
        {title}
      </legend>
      {types.map(([type, label]) => (
        <label key={type} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm leading-none select-none hover:bg-muted">
          <Checkbox checked={ticked.has(type)} onCheckedChange={(on) => onTick(type, on === true)} />
          <ItemTypeIcon type={type} decorative className="size-4" />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

/** Searches as you type, once typing pauses; Enter searches at once. */
function SearchBar({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [draft, setDraft] = useState(initial);
  // Follows the URL when it changes otherwise, as on Back.
  const [searched, setSearched] = useState(initial);
  if (initial !== searched) {
    setSearched(initial);
    if (draft.trim() !== initial) setDraft(initial);
  }
  // `onSearch` is a fresh function each render; the draft and the URL are what start a search.
  const search = useRef(onSearch);
  useEffect(() => {
    search.current = onSearch;
  });
  useEffect(() => {
    if (draft.trim() === initial) return;
    const timer = setTimeout(() => search.current(draft.trim()), TYPING_MS);
    return () => clearTimeout(timer);
  }, [draft, initial]);
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
          aria-label="Search Observables"
          placeholder="Search by value, defanged or not…"
          value={draft}
          maxLength={200}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
        />
      </InputGroup>
    </form>
  );
}
