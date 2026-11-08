---
target: working pages after widening
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/user/argus/apps/web/src/routes"
timestamp: 2026-11-08T15-21-32Z
slug: apps-web-src-routes
---
Method: dual-agent (A: design review · B: detector + browser evidence)

Target: working pages after widening from max-w-6xl to max-w-page (1920px), commit fb61266.

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | At 2560 a row's Status/Updated sits ~1100px from its Title |
| 2 | Match system / real world | 3 | Unaffected |
| 3 | User control and freedom | 3 | Alert selection toolbar: "Clear selection" ~1800px from the count |
| 4 | Consistency and standards | 2 | Page left edges jump between areas (495 / 968 / 344px at 2560); only some tables adapt |
| 5 | Error prevention | 3 | Unaffected |
| 6 | Recognition rather than recall | 3 | Shortcut hints pushed to the far right |
| 7 | Flexibility and efficiency | 3 | Extra width never becomes extra columns |
| 8 | Aesthetic and minimalist design | 2 | 460px selects, 1700px add-inputs, 1920px Search and Bulk Lookup fields |
| 9 | Error recovery | 3 | Unaffected |
| 10 | Help and documentation | 3 | Unaffected |
| Total | | 28/40 | Good |

Detector: CLI clean on src/routes and app-shell. Overlay flagged 1 issue: Case Summary paragraph ~136 characters per line at 2560, in the new 3-column Overview.

Priority issues
- [P1] Tables stretch instead of adapting (Cases list, Tasks, Search). Rows span up to 1920px, the Title column is mostly empty, and actions and metadata sit at the far edge. Fix: @container plus colgroup caps and extra columns at wide sizes, or cap these tables. /impeccable layout
- [P1] The 3-column Overview makes 1920 worse: Open Tasks titles truncate. It also misses its goal, since the Summary runs ~130-136 characters per line at 2560. Fix: raise the breakpoint to ~104rem and add max-w-[75ch] on the Summary prose. /impeccable layout
- [P1] With the sidebar collapsed on Case pages, the icon rail shows a clipped Work queue (probably caused by scrollIntoView in work-queue.tsx; predates the change). Fix: skip the call when collapsed, or use overflow-x: clip. /impeccable harden
- [P2] The header and content don't share a left edge, and page edges move between areas. Fix: left-align working pages, or put the header in the same frame. /impeccable layout
- [P2] Controls stretch (Case header selects, Observables add row, Search field, Bulk Lookup form; Bulk Lookup's form was max-w-5xl before). Fix: cap the forms and keep only the tables wide. /impeccable polish

Personas: Alex: toolbar and hints far from focus. Sam: far-right focus rings are easy to lose; /settings/members has no h1 (predates the change). Ultrawide Analyst: a 1920px island with 585px gutters; collapsing the sidebar breaks Case pages.

Minor: Observables and Assets tables have misaligned columns; empty area under the 3-column Overview; the "All open" tab shows a focus ring after a mouse click; the nested div's indentation in overview.tsx is off.

Questions: Second working surface instead of a wider page? Left-align instead of centre? Per-page caps instead of one 1920px cap?
