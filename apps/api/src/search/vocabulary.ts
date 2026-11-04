/** What global search looks through (GLOSSARY.md), in the order results are shown. Shared with the SPA. */
export const SEARCH_KINDS = ["cases", "alerts", "observables", "assets"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export const searchKindLabel: Record<SearchKind, string> = {
  cases: "Cases",
  alerts: "Alerts",
  observables: "Observables",
  assets: "Assets",
};

/** Results of each kind a search returns unless asked for fewer or more. */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;
