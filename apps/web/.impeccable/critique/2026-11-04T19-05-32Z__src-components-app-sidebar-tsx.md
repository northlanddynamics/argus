---
target: case side nav
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/user/argus/apps/web/src/components/app-sidebar.tsx"
target_fingerprint: "sha256:50fa50c288b2216337ffca4897227ab50ae14d9637d6ed5e9ff6cc9188176ab5"
target_path: /home/user/argus/apps/web/src/components/app-sidebar.tsx
timestamp: 2026-11-04T19-05-32Z
slug: src-components-app-sidebar-tsx
---
Method: dual-agent (A: design review · B: detector + browser)

Target: Case side nav: Active Cases panel, Guest "Your Cases" panel, icon NavRail (src/components/app-sidebar.tsx).

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | No loading/error state; open Case off-screen; silent live re-sorts |
| 2 | Match System / Real World | 3 | "Active Cases" vs list's "All open" |
| 3 | User Control and Freedom | 2 | Mine/search reset on reload; rows move under pointer |
| 4 | Consistency and Standards | 2 | Panel defaults all vs list My Cases; Restricted icon-only; no j/k here |
| 5 | Error Prevention | 2 | Live recency sort invites misclicks; Guest error never clears |
| 6 | Recognition Rather Than Recall | 3 | Rows self-describing; shortcuts undiscoverable |
| 7 | Flexibility and Efficiency | 2 | No keyboard movement, no Severity sort, search ignores Assignee |
| 8 | Aesthetic and Minimalist Design | 3 | Calm; 90-108px rows, 7 fit in 900px |
| 9 | Error Recovery | 1 | Failed fetch = blank panel, no retry |
| 10 | Help and Documentation | 2 | Good empty copy; nothing on Mine or shortcuts |
| Total | | 22/40 | Acceptable |

## Design Specificity Verdict
Stock sidebar-09 frame (on brief); rows carry domain markers (mono refs, greyscale Severity, lock, GLOSSARY Status). Ignores Guests (c.guests), presence (useCasePresence), Alerts (c.alerts) already available. Reads as an inbox, not a triage console.
Detector: CLI 0 findings (app-sidebar, app-shell, nav-user). Browser overlay: light 9 (low-contrast 4.3:1 muted on active row app-sidebar C-ref; NavUser "OO" 4.3:1; 7x tight-leading 1.25 on line-clamp-2 titles), dark 7 (tight-leading). Measured: active-row meta 4.35:1 light; active bg vs sidebar 1.04:1 light / 1.18 dark; Case-link focus ~1.5:1; collapsed panel stays in tab order.

## Priority Issues
- [P1] Loading/error render blank (app-sidebar.tsx:233 gated on cases.data). Fix: skeleton + role=status; destructive message + Try again (list.tsx:203-216 pattern); Guest panel too. /impeccable harden
- [P1] Collapsed panel focusable and breaks rail; Case-link focus ~invisible (itemClass :40); 1 tab stop per Case; no j/k; name starts with ref/Severity/time. Fix: inert when collapsed; focus-visible ring; roving tabindex reusing useRowKeys (list.tsx:95-112); title-first name. /impeccable harden
- [P1] Open Case not visible: off-screen (no scrollIntoView), active bg 1.04:1, meta 4.35:1, rail active lacks aria-current. Fix: scrollIntoView nearest on current change (:177); 2px inset foreground bar; tokenized meta colour >=4.5:1. /impeccable polish
- [P2] Rows omit Restricted words, Guests, presence, Alerts, Overdue Tasks (:219-229). Fix: muted tokens on line 3, presence avatars, expose overdueTasks in api cases.ts:115-127. /impeccable clarify
- [P2] Panel vs list disagree (14 all vs My Cases 4; Active/All open; Mine/My Cases); count ignores Mine and caps at 500 (:188); state not persisted. Fix: filtered count + counts.open; align vocabulary/default; persist Mine; decide panel's role on /. /impeccable distill

## Persona Red Flags
Alex: no j/k in panel; no Severity sort (Critical C-11 4th); search ignores Assignee/Status; Ctrl/Cmd+B undiscoverable; collapsed rail has no Case awareness.
Sam: invisible row focus; collapsed focus breaks rail; 10th Case = Tab 19; names start "C-14Medium2 min ago"; rail no nav landmark; mobile sheet stock SR title (ui/sidebar.tsx:196); Guest error no role=alert.
Gail (Guest): no Severity/Status on rows; Org name repeated; unexplained order; buttons not links; no Org-switch feedback; sticky error.

## Minor Observations
"Informational" widest badge; leading-tight on 2-line titles; ~270px chrome above list on mobile; panel persists on Settings/Dashboard; relative times don't tick; panel placeholder competes with global search; rail tooltips stack while tabbing; React "script tag" console error (likely next-themes).

## Questions to Consider
- Second Case list or working set? Why on / next to the real list?
- Should Critical ever sort below Low because of a later edit?
- Why does the all-day view hide which Cases have outside Guests?
