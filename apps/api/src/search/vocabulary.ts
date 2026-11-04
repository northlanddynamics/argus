/** What global search looks through (GLOSSARY.md); ties in rank go to the kind listed first. Shared with the SPA. */
export const SEARCH_KINDS = ["cases", "alerts", "observables", "assets"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export const searchKindLabel: Record<SearchKind, string> = {
  cases: "Cases",
  alerts: "Alerts",
  observables: "Observables",
  assets: "Assets",
};

/** Results on a page unless asked for another size. */
export const SEARCH_DEFAULT_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE_SIZE = 50;
