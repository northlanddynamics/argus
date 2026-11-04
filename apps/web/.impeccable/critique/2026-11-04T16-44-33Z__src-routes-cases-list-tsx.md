---
target: case list page
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/user/argus/apps/web/src/routes/cases/list.tsx"
target_fingerprint: "sha256:af7af7370402c108dd736338674268c1781b8f1d9ffa4ede6698fef13c0ad451"
target_path: /home/user/argus/apps/web/src/routes/cases/list.tsx
timestamp: 2026-11-04T16-44-33Z
slug: src-routes-cases-list-tsx
---
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Live re-sort works; loading and error render as an empty table (isPending/isError unrendered, list.tsx:58-65, 118-161) |
| 2 | Match System / Real World | 3 | GLOSSARY terms faithful; subtitle describes controls, not work (list.tsx:76) |
| 3 | User Control and Freedom | 2 | No "Clear filters"; four selects reset one by one. Filters are URL-persisted (good) |
| 4 | Consistency and Standards | 2 | Local `ago` ("just now"/"11/3/2026") vs sidebar ("0 s ago"/"Nov 3"); custom tag span not Badge (list.tsx:136); view tabs are buttons that navigate |
| 5 | Error Prevention | 2 | Status filter offers impossible values per view (list.tsx:99, api cases.ts:300-304) |
| 6 | Recognition Rather Than Recall | 3 | Tab counts ignore filters (api cases.ts:323-327) |
| 7 | Flexibility and Efficiency | 1 | No sort, no in-page text search, no row keyboard nav, no bulk actions; 2 tab stops/row; no skip link |
| 8 | Aesthetic and Minimalist Design | 3 | Quiet and correct in both themes; sidebar Active Cases duplicates the list |
| 9 | Error Recovery | 1 | Query error thrown, never shown; "No Cases here." covers empty, filtered-empty and failed (list.tsx:157) |
| 10 | Help and Documentation | 2 | Lock icon unexplained; no shortcut hints |
| **Total** | | **21/40** | **Acceptable, significant gaps** |

## Design Specificity Verdict
LLM: partly specific. Vocabulary and markers (mono C-refs, Severity by weight, "Closed · Benign") are right; structure is a generic tracker. Missing: who-can-see-what (Restricted is a 14px icon, Guests invisible), Alert-to-Case flow, any "needs me now" signal.
Deterministic: `impeccable detect` clean on list.tsx and case-badges.tsx. Overlay: light 5 / dark 2 / empty 3. low-contrast x3 at 4.35:1 (muted-foreground on bg-muted): 2 Tag chips (list.tsx:136, real, in scope), 1 sidebar avatar (shell). tight-leading x2: sidebar line-clamp-2 titles (app-sidebar.tsx:229, 281; shell, out of scope).

## Priority Issues
- [P1] Error and loading states missing; failure reads as an empty queue. Fix: skeleton rows, inline destructive Alert + Retry, distinct empty vs filtered-empty copy with next step. Command: harden
- [P1] Not keyboard-first: no skip link, sidebar before table, 2 links per row, faint ring. Fix: skip link, single row link, j/k/Enter, tabs as Links/tablist. Command: harden, polish
- [P1] Who-can-see-what absent: icon-only Restricted (list.tsx:128), no Guest indicator, no Restricted filter for Admins. Fix: lock + "Restricted" text, "n Guests" chip, Admin filter, Alert count. Command: clarify, layout
- [P2] Filters/counts/sort incoherent: counts ignore filters, Closed tab uncounted (list.tsx:94), impossible Status options, fixed updatedAt sort, Severity 4th, silent 500-row cap (api cases.ts:322). Fix: filter-aware counts, scoped Status options, Clear filters, sortable headers, Severity next to ref, pagination or "Showing 500 of N". Command: layout, harden
- [P2] Sidebar Active Cases duplicates the page (app-sidebar.tsx:178-230). Fix: collapse it on `/` or merge its search into the filter bar. Command: distill

## Persona Red Flags
Analyst: 15+ Tabs to table; no Severity sort; no in-page search; native selects slow; live re-sort moves rows without highlight.
Admin: Restricted mixed in with a small lock; no Restricted filter; Guest grants invisible.
Guest: separate GuestHomePage with no Status/Severity/updated; titles are buttons, not links (guest-home.tsx:29-37); no leak.

## Minor Observations
- Tag chips 4.35:1, faint in dark, not pill Badge (list.tsx:136)
- `ago` duplicates lib/alerts, rounds 90 min to 2 h, no exact-time title (list.tsx:44-50)
- Case Type column low-value width
- No caption / th scope; row hover implies clickability that isn't there
- "+ Open Case" literal plus
- 390px: table scrolls internally, long title 14 lines (screen sizes undecided)
- next-themes script-tag console warning app-wide

## Questions to Consider
- If the sidebar lists Active Cases, should this page be the full queue and the sidebar only recent/pinned?
- What if access (Restricted, Guests n) were a column?
- Should default order be "what needs me" rather than "last touched"?
