---
target: integrations and observable actions
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/user/argus/apps/web/src/routes/settings/integrations.tsx"
target_fingerprint: "sha256:59c6af862e755e6d314f1807a4be2e3c9917fd4069d10cd010b6e9bcc255a567"
target_path: /home/user/argus/apps/web/src/routes/settings/integrations.tsx
timestamp: 2026-11-06T03-30-51Z
slug: apps-web-src-routes-settings-integrations-tsx
---
Method: dual-agent (design review + detector/browser)

## Design Health Score: 22/40 (Acceptable)
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Send dialog closes silently; false "No Response Actions yet." while loading/erroring; Integrations page silent on Response Actions |
| 2 | Match System / Real World | 3 | "Read only" on an IOC-writing Integration; "Owned by worker"/"Stored offset" jargon |
| 3 | User Control and Freedom | 2 | Dismiss, Response Actions switch, write-back switch, Pause, Teams Remove act on one click |
| 4 | Consistency and Standards | 2 | Ignored and relying-Cases warnings use grey Alert, not Amber Notice |
| 5 | Error Prevention | 2 | All Integrations pre-ticked; no already-sent warning; Severity and Prevent effect unstated |
| 6 | Recognition Rather Than Recall | 2 | Rows don't show sent state; unsendable rows give no reason |
| 7 | Flexibility and Efficiency | 2 | Bulk send good; no grouping/filter/bulk retry |
| 8 | Aesthetic and Minimalist Design | 2 | Duplicate rows; clipped row actions; stream internals always shown |
| 9 | Error Recovery | 3 | Inline error + Retry + notification; card-level errors not tied to rows |
| 10 | Help and Documentation | 2 | Scopes in one parenthetical; no Test connection |

## Detector
CLI: 0 findings in integrations.tsx, response-actions.tsx, observables.tsx. Browser: 8 nested-cards on /settings/integrations (Stat tiles, integrations.tsx:204-207, 294-300); 0 on observables.

## Priority Issues
1. [P1] Send dialog commits outward actions without showing existing state: all Integrations pre-ticked (response-actions.tsx:126), no already-sent state, Severity/Prevent effect unstated, silent success, self-referential duplicates, already-present shows wrong action. Fix: pre-send Observable x Integration state list, untick by default, state Severity and Prevent effect, success toast. /impeccable harden
2. [P1] Observable rows clip actions at 1440px (observables.tsx:293) and hide Response Action state; unsendable rows give no reason. Fix: overflow menu or full width, sent-state marker, reason in place of Send. /impeccable layout
3. [P1] Integrations page has no Response Action visibility; switch enables instantly without scope check or Amber confirm (integrations.tsx:249); "Read only" badge wrong (:192). Fix: counts/last failure/Org-wide list link, scope verification + Amber confirm, rename badge, disclose stream internals. /impeccable clarify
4. [P2] Response Actions table: false empty state (:430,526), card-level errors (:442), unlabelled Retry/Dismiss (:507,512), unconfirmed Dismiss, "Removed" for dismissed, solid "Active" badge reads as in force. /impeccable distill then harden
5. [P2] Grey Alerts break One Amber Rule (:229,365); Remove dialog truncates hash (:338) and says "stops detecting" for Prevent. /impeccable polish

## Persona Red Flags
Alex: re-ticked Integrations, select-all includes unsendable, single-row Retry, clipped actions, silent success.
Sam: title-only info, unnamed table, identical button names, no aria-live, disabled switches without reason.
Admin first Integration: CrowdStrike only, crammed scopes, no Test connection, enable without scope, misleading "Read only", no Org-wide view of owned IOCs.

## Minor Observations
Identifier Rule gaps for Case references; no loading/error on Integrations queries; Guest-visible default inconsistency; break-all splits domains; item page Sent column mixes formats; audit wording "Denied write-back".

## Questions
- Why is "Active" one of the heaviest badges if it must not mean in force?
- Where does an Admin see which IOCs Argus owns in a Provider?
- Should the row control be "Take Response Action…" per Provider rather than "Send to X"?
