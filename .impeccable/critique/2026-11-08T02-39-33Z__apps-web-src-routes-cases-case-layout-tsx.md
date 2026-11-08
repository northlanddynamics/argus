---
target: case page
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/user/argus/apps/web/src/routes/cases/case-layout.tsx"
target_fingerprint: "sha256:8cd8c999d708540fe013b8e0c931b3b18e10f5f6ea1ec811d60732b7d19a0c92"
target_path: /home/user/argus/apps/web/src/routes/cases/case-layout.tsx
timestamp: 2026-11-08T02-39-33Z
slug: apps-web-src-routes-cases-case-layout-tsx
---
Method: dual-agent (design review + detector/browser)

## Design Health Score: 26/40 (Acceptable)
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Blank page while the Case loads or fails; Select changes save silently |
| 2 | Match System / Real World | 3 | UTC time field shows 12h "12:00 AM" |
| 3 | User Control and Freedom | 2 | 1-6 keys fire from focused toggles and drop drafts; Discussion draft lost on tab switch; Case Role x has no undo |
| 4 | Consistency and Standards | 2 | Observables relative times; Tasks tab unsorted vs Overview; visibility cue differs per tab |
| 5 | Error Prevention | 3 | Audience cue good; Close Case doesn't warn only Admin can reopen |
| 6 | Recognition Rather Than Recall | 3 | Section keys only in title tooltip |
| 7 | Flexibility and Efficiency | 2 | No keys for frequent actions; no bulk Task completion; no "now" for entry time |
| 8 | Aesthetic and Minimalist Design | 3 | Severity/overdue repeated above fold; Visibility menu per row |
| 9 | Error Recovery | 3 | Conflict recovery excellent; failed Case load is a blank page |
| 10 | Help and Documentation | 2 | Shortcuts undiscoverable; no help for Promote/Retract/Occurred-at |

## Detector
CLI 0 findings. Browser: 1 nested-cards on Evidence drop zone (evidence.tsx:78) - false positive. No 1024px overflow. Muted contrast 4.74 light / 6.9+ dark; header "/" kbd 4.35 (outside Case page).

## Priority Issues
- [P1] Section keys 1-6 fire from focused toggles/buttons and destroy drafts (case-layout.tsx:77); Discussion draft lost on tab switch. /impeccable harden
- [P1] Close Case doesn't say only an Admin can reopen (close-case-dialog.tsx:100). /impeccable clarify
- [P2] No loading/error state for the Case (case-layout.tsx). /impeccable harden
- [P2] Inconsistent conventions: Observables relative times, Tasks tab unsorted, 12h UTC input, no Audience on Summary editor, Observables lack Visibility cell. /impeccable polish
- [P2] Header crowding and repetition; 1024 tab wrap; 57 flat Audit actions; Audit filter card touches table. /impeccable distill + adapt

## Persona Red Flags
Alex: no action shortcuts, no bulk Task completion, no "now" time. Sam: 19 identical "Promote to Timeline" names; entry aria-label repeats body; no live region for saved Selects. Kim (Guest): Members can't see Summary/Tasks reach Guests from Overview. Handover: no Summary timestamp; Case Role removal no undo.

## Minor Observations
Alert queue link not Case-scoped; faint Occurred-at toggle state; Retract styled destructive red; empty Falcon columns shown; muted 4.7:1 margin.
