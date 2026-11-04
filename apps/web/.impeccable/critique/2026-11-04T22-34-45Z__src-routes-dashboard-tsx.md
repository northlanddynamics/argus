---
target: dashboard page
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
target_identity: "file:/home/user/argus/apps/web/src/routes/dashboard.tsx"
target_fingerprint: "sha256:fc49f876817c2c652950bfba91df9cfe1df3c00e0f331ffa49b522638bb2ea39"
target_path: /home/user/argus/apps/web/src/routes/dashboard.tsx
timestamp: 2026-11-04T22-34-45Z
slug: src-routes-dashboard-tsx
---
Method: dual-agent (A: design review · B: detector + browser)

Target: Metrics Dashboard (src/routes/dashboard.tsx), viewed live with seeded data at 1440/1280/800, light and dark, 7/30/90 days.

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | No "updated at"; period switch shows old numbers with no pending cue |
| 2 | Match System / Real World | 3 | "of 38 decided Alerts dismissed, not attached" is hard to parse |
| 3 | User Control and Freedom | 3 | No comparison with the previous period |
| 4 | Consistency and Standards | 2 | Plain-text Severity, off-pattern error, max-w-7xl, 30px figures |
| 5 | Error Prevention | 3 | Every zero in the matrix is a link to an empty list |
| 6 | Recognition Rather Than Recall | 3 | Chart values only in a hover readout far from the cursor |
| 7 | Flexibility and Efficiency | 2 | 36 tab stops in the matrix; charts not drillable or keyboard-reachable |
| 8 | Aesthetic and Minimalist Design | 3 | KPI grid orphan; trend chart ~400px tall for 4–5 points |
| 9 | Error Recovery | 1 | One-line error, no retry, no role=alert, stale data unflagged |
| 10 | Help and Documentation | 3 | Figures define themselves; nothing explains 100% or "—" |
| **Total** | | **26/40** | **Acceptable** |

## Design Specificity Verdict
Partly authored. The Severity × Status matrix and its drill-down into the Case list's filters, the stated scope and n, and the Glossary vocabulary are Argus's own. The composition is the stock analytics template (five equal KPI cards, bar chart, bar list, two-line trend) and leaves out Argus's own markers: Severity badges and the Attention Rule.
Detector: 3 advisory design-system-font-size (text-[11px] at dashboard.tsx:374,379,382, SVG text); 0 in light and 90-day overlays; 1 dark-mode low-contrast (2.9:1) on the notification bell badge, notification-bell.tsx:65.

## Priority Issues
- [P1] Doesn't answer "what needs attention now": no Alerts-awaiting-decision count, "unassigned" not a link, no signal on unassigned Critical in New, 30px figures outrank the h1. → clarify, layout
- [P2] Trend chart: viewBox + w-full scales labels (11px→~19px at 1440, ~10px at 800), ~400px tall, sparse data draws as lone dots, empty trailing week. → polish/adapt
- [P2] Charts are mouse-only: aria-hidden, unfocusable, series differ by hue only. → harden
- [P2] Convention drift: SeverityBadge unused, error state not the cases/list.tsx:189-197 pattern, max-w-7xl, no isPlaceholderData cue. → harden, polish
- [P2] KPI grid orphan (lg:3 / 2xl:5) and mixed Case/Alert grouping. → layout

## Persona Red Flags
- Alex (power user): 36 tab stops; no drill-down from bars or Dismissal Reasons; no previous-period comparison.
- Sam (accessibility): hover-only chart values; matrix focus is 1px outline + underline, not the 3px ring; colour-only legend; ~10px axis text at 800.
- Lena (shift lead): can't see undecided Alerts or the oldest New item; "5 unassigned" not clickable; 30-day default and weekly buckets hide today; UTC days.

## Minor Observations
- 90-day trend last label (Nov 18) vs volume last day (Nov 23).
- Dismissal shares sum to 99%.
- --series-2 orange-red sits close to Overdue Red.
- Matrix stretches 7 columns across ~1250px.
- "Time to acknowledge and close — trend" title; h1 "Dashboard" generic.
- Shared shell: dark-mode bell badge contrast 2.9:1 and 10px text.

## Questions to Consider
- What if the page opened on "now" with trends below?
- Does an unassigned Critical in New earn a signal treatment here?
- Do four weekly points earn 400px, or would sparklines in the figures do?
- If matrix counts drill down, why not the Alert charts?
