---
target: case page
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/user/argus/apps/web/src/routes/cases/case-layout.tsx"
target_fingerprint: "sha256:cc0c418a32acc0047ad03f940f4b0f989711239198c7e14734a25a0cb99c0f8c"
target_path: /home/user/argus/apps/web/src/routes/cases/case-layout.tsx
timestamp: 2026-11-08T00-59-00Z
slug: apps-web-src-routes-cases-case-layout-tsx
---
Method: dual-agent (design review + detector/browser)

## Design Health Score: 25/40 (Acceptable)
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Live dot, presence, Summary version good; overdue state invisible from Overview/header |
| 2 | Match System / Real World | 3 | Glossary terms, defanging, UTC Timeline right; unlabelled local times elsewhere |
| 3 | User Control and Freedom | 3 | Undo on Visibility, Retract "Keep it"; Tag removal one-click no undo; unassign-from-Restricted silently redirects |
| 4 | Consistency and Standards | 2 | Four time formats; Severity a Select not a badge; uppercase vs Title card titles; composers at opposite ends |
| 5 | Error Prevention | 2 | New items default visible to Guests with no send-time reminder; Export defaults to Complete |
| 6 | Recognition Rather Than Recall | 3 | Must remember to check Tasks for overdue; Ctrl/Cmd+Enter undiscoverable |
| 7 | Flexibility and Efficiency | 2 | No Case-page shortcuts; no Assign to me; one-at-a-time Tasks/Promote |
| 8 | Aesthetic and Minimalist Design | 2 | 6-card rail (4 empty) vs ~400px dead space; 19 Promote buttons; always-open entry form |
| 9 | Error Recovery | 3 | Summary conflict flow model-grade; C-999 page has no way back |
| 10 | Help and Documentation | 2 | Good inline descriptions; no contextual help or shortcut reference |

## Design Specificity
Vocabulary and markers are Argus-specific (mono C-1, defanged Observables, dashed Internal, "Retract" copy); composition is a generic shadcn record page. Severity weight, Overdue Red and Guest names never reach the Case header.
Detector: CLI 2 advisory design-system-font-size (text-[11px] badge at contain-host-dialog.tsx:217, host-falcon.tsx:64), both real. Browser: straggler at related-alerts-panel.tsx:49 (real, minor); em-dash-overuse on Audit Log (false positive: null placeholders + seed title). Contrast passes AA (muted 4.54-4.74 light).

## Priority Issues
- [P1] New content defaults visible to Guests with no reminder at send; the warning (timeline.tsx:39) shows only when there are NO Guests; Export defaults to Complete. Fix: "Visible to Kim Patel (Guest)" beside Send/Add entry/drop zone; invert the note; consider Internal-by-default. /impeccable harden
- [P1] Overview doesn't surface attention items; 6-card rail with 4 empty states, dead left column, no Severity badge, Tasks badge "0/4" hides 1 overdue, "Access 1" hides Guest. Fix: SeverityBadge by title, overdue on Tasks tab, Guest name on Access, Open Tasks under Summary, collapse empty rail cards. /impeccable layout
- [P1] Four time formats / two zones, local unlabelled (overview.tsx:21, discussion.tsx:161, evidence.tsx:144, audit-log.tsx:220, case-layout.tsx:155 vs timeline.tsx UTC). Fix: one formatInstant() everywhere. /impeccable clarify
- [P2] 1024px breaks: Discussion clipped (timeline.tsx:44 no min-w-0), Observable values shrink to 54px, Audit Log tab scrolls off. /impeccable adapt
- [P2] Per-row button noise (19 Promote, Discussion/Timeline row buttons) and always-open Timeline Entry form above the record. /impeccable distill

## Persona Red Flags
Alex: no Case-page shortcuts; 14 Tab stops to tab bar; no Assign to me; one-at-a-time Tasks/Promote.
Sam: no headings on Overview (CardTitle is div); @mention listbox not linked to textarea; 16px Tag remove with no visible focus ring; disabled Selects at 50% opacity for Guests/Closed.
Kim Patel (Guest): header is greyed-out disabled form controls; nothing states what she can do; Case Roles/Linked Cases render without Guest guard.

## Minor Observations
Uppercase tracking-widest rail titles vs Title-case Case Summary; "Last saved · v1" above "Nothing written yet."; Audit Log targets not defanged; "→ —" for adds; disabled Closed in Status with no hint; Timeline/Discussion tops misalign ~13px; disabled filled buttons louder than enabled outline; C-999 no link back; 11px badges; straggler in Related Alerts.

## Questions
1. With a Guest on the Case, should visible-to-Guests ever be the silent default?
2. What if Overview were the next-action view rather than Summary plus six metadata boxes?
3. Is the Timeline a document you read or a form you fill?
