---
target: alert list page
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/user/argus/apps/web/src/routes/alerts/queue.tsx"
target_fingerprint: "sha256:2fec699af5f8649da2abb7449218a4956b7031d5c1ce6252def5d846fa7e3c51"
target_path: /home/user/argus/apps/web/src/routes/alerts/queue.tsx
timestamp: 2026-11-04T17-34-19Z
slug: src-routes-alerts-queue-tsx
---
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Loading/error render as an empty queue (isPending/isError unread, queue.tsx:225-282); AlertPanel returns null while loading/404 (queue.tsx:407); Integration in Error is grey text (queue.tsx:111) |
| 2 | Match System / Real World | 3 | "Detection" column header is a GLOSSARY Avoid term (queue.tsx:217); "Dismiss notice" collides with the Dismiss action |
| 3 | User Control and Freedom | 2 | Esc doesn't close the panel; panel has no actions for New Alerts; selection silently survives filter changes |
| 4 | Consistency and Standards | 2 | Cases list has j/k row keys, queue has none; custom inverted toolbar (queue.tsx:168); native radios in dialogs (alert-dialogs.tsx:89, 349, 440) |
| 5 | Error Prevention | 3 | Version-pinned selection is strong; `highest` ignores hidden selected Alerts (queue.tsx:90-91); Case Type always defaults to Malware |
| 6 | Recognition Rather Than Recall | 2 | Dialogs don't list the selected Alerts; refusals show id without title (queue.tsx:319); Received has no date (queue.tsx:52) |
| 7 | Flexibility and Efficiency | 1 | No shortcuts, no shift-range, no sort; focus drops to body after panel open and every bulk action |
| 8 | Aesthetic and Minimalist Design | 2 | Selection slab is the loudest element; table overflows its card |
| 9 | Error Recovery | 3 | Partial-failure notice is excellent; dialogs show raw API errors; queue load failure shows nothing |
| 10 | Help and Documentation | 2 | Inline consequence Notes help; no shortcut help; "an Admin adds one in Settings" not linked |
| **Total** | | **22/40** | **Acceptable** |

## Design Specificity Verdict
LLM: mostly category-interchangeable (filter card → table → modal per action) with authored markers: Severity by weight, mono external ids, version-checked selection with per-Alert refusal notice, "a Case you can't see". Built like a ticket list, not a triage surface.
Detector: CLI 0 findings. Browser: low-contrast 4.3:1 muted-foreground on bg-muted on selected rows (queue.tsx:246, 252, 254 via table.tsx:59) and dialog Note (alert-dialogs.tsx:117), light theme only; Avatar "AA" in app shell (out of scope). em-dash-overuse is a false positive (seeded Integration name "CrowdStrike — Prod").

## Priority Issues
- [P1] Table overflows; Host/user, Received, Status off-screen (whitespace-nowrap titles; worse with panel open). Fix: truncate title, fixed widths, fold Integration into meta line. /impeccable layout
- [P1] Missing loading and error states read as an empty queue. Fix: skeleton + status, destructive Alert with Retry, panel skeleton and 404 copy, Amber Notice for unhealthy Integration. /impeccable harden
- [P1] No keyboard triage path. Fix: reuse useRowKeys (j/k, x, shift-range, Enter/Esc), o/a/d with selection, focus return, single-Alert actions in panel. /impeccable harden
- [P2] Custom black selection toolbar: loudest element, inverted in dark, primary button invisible, 68px layout jump. Fix: sticky card/muted bar with hairline, reserved space, one primary, ghost Clear. /impeccable quieter
- [P2] Copy/vocabulary: "Detection"→"Alert", "Status"→"Alert Status", "Dismiss notice"→Close, "1 of 3 Alerts were" grammar (queue.tsx:313), stale "Attaching this Alert adds…" on attached Alerts (queue.tsx:491), refusal titles, raw API errors. /impeccable clarify

## Persona Red Flags
Alex: zero shortcuts, no shift-range, 68px jump misfires clicks, Open Case title not prefilled, Malware default for Identity Alerts, focus lost after each action, no sort.
Sam: focus to body on panel open; panel div has no role; no Esc; title button lacks 3px ring (queue.tsx:243); native blue radios; live arrivals/count not in a live region; 4.3:1 secondary text on selected rows.
Analyst in a CrowdStrike burst: no group/sort by host; new rows shift the list mid-selection; hidden selections after filter change skew Severity default; no date on Received; silent 500 cap (QUEUE_LIMIT).

## Minor Observations
Host/user not mono, Integration name mono in panel; empty state lacks guidance and Clear filters; "Refreshing from Falcon…" no timeout; success notice persists across filter changes; panel h2 text-lg breaks Two Sizes Rule; misplaced JSDoc (queue.tsx:341-343); Falcon comments on Restricted-Case Alerts visible to all Members (policy decision).

## Questions to Consider
- Should the unit of action be focused row + keystroke, with a modal only for Open Case?
- Should a burst group by host/Asset and sort Severity-then-time?
- How much should an Analyst learn about Alerts attached to Cases they can't see?
