---
target: case page
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/user/argus/apps/web/src/routes/cases/case-layout.tsx"
target_fingerprint: "sha256:cc0c418a32acc0047ad03f940f4b0f989711239198c7e14734a25a0cb99c0f8c"
target_path: /home/user/argus/apps/web/src/routes/cases/case-layout.tsx
timestamp: 2026-11-04T12-38-36Z
slug: src-routes-cases-case-layout-tsx
---
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Live indicator and presence work; Status/Severity/Case Type/Assignee changes save silently; Tasks tab "0/3" hides the overdue Task |
| 2 | Match System / Real World | 3 | GLOSSARY terms used faithfully; three date formats (local with seconds, UTC, bare ISO) |
| 3 | User Control and Freedom | 2 | Restricted, Mark Internal/Show to Guests, Remove Guest, Unlink, Remove Tag apply in one click, no confirm or undo |
| 4 | Consistency and Standards | 2 | Mixed date formats, heading levels, uppercase rail titles, "+ Assign"/"+ Add Observable" wording |
| 5 | Error Prevention | 2 | Close Case dialog silent about open/overdue Tasks and Guests; Evidence "Add as Internal" after file picker and sticky |
| 6 | Recognition Rather Than Recall | 3 | Overdue Task invisible on Overview; Alert queue link not filtered to the Case |
| 7 | Flexibility and Efficiency | 1 | No section shortcuts, no bulk actions, 21 Tab presses to content, no skip link |
| 8 | Aesthetic and Minimalist Design | 3 | Calm; per-row "Mark Internal" buttons, always-open Timeline form, empty space under Summary |
| 9 | Error Recovery | 3 | Excellent version-conflict recovery; errors inline |
| 10 | Help and Documentation | 2 | Resolutions undefined; dense Observables footnote |
| **Total** | | **24/40** | **Acceptable** |

## Design Specificity Verdict
LLM: the layout is interchangeable with any work-tracking tool (title, four Selects, tab strip, card grid); the details are Argus-specific (dashed Internal badge, monospace references, Retract not delete, conflict recovery). Severity is plain text in the header; Guest presence is hidden behind "Access".
Deterministic scan: CLI 0 findings, 1 advisory (text-[11px] presence-avatars.tsx:29). Rendered: low-contrast 4.3:1 muted Case ref on active sidebar item (app-sidebar.tsx:201,265) and avatar fallback initials (nav-user.tsx:48, shadcn default); dark-mode notification count badge 2.9:1 white on red, 10px (notification-bell.tsx:65); line-length 188ch Observables footnote (observables.tsx:70). Overlay injected headless; no user-visible overlay.

## Priority Issues
- [P1] Audit Log and Observables tables overflow at 1440px: full SHA-256 in Action (audit-log.tsx:213) pushes Before→After to ~30px and Promote off-screen; Observables "Unlink" clipped (observables.tsx:415-427). Fix: break/truncate hash with copy, min-width Before→After, Promote in row menu, fold "Added by" under value. Command: /impeccable layout
- [P1] Visibility shown as an action, not a state, in Timeline and Discussion (showVisible=false, timeline.tsx:128, discussion.tsx:171). Fix: always show "Visible to Guests" or Internal badge; toggle in menu; one "No Guests on this Case" note when none. Command: /impeccable clarify
- [P1] Actions that change who can see what have no safety net: Restricted checkbox (case-access-dialog.tsx:171), Remove Guest (:283), Show to Guests (visibility.tsx:41), sticky Evidence "Add as Internal" after picker (evidence.tsx:87-97); Close Case omits open/overdue Tasks. Fix: confirm Show to Guests naming Guests, undo toast, Internal choice before picker and reset, consequences in Close Case. Command: /impeccable harden
- [P2] Overview doesn't surface what needs attention: overdue Task only on Tasks tab, neutral "0/3", Severity not badged in header, Guests hidden. Fix: "Needs attention" line under Summary, Overdue Red Tasks badge, Severity badge and Guest count beside C-1. Command: /impeccable layout
- [P2] Keyboard and contrast: focus ring ~1.5:1 (ring at 50%), no skip link, 21 Tabs to content, card titles not headings, @mention listbox not wired (discussion.tsx:372-403), muted Case ref 4.3:1 on active item, dark count badge 2.9:1. Command: /impeccable audit

## Persona Red Flags
Alex: no section/Close/Assign shortcuts; no bulk Tasks or Internal; Timeline form pushes entries below fold; Promote off-screen; Alert queue unfiltered.
Sam: invisible focus ring; no skip link; no section headings; mention picker not announced; silent property saves; presence avatar lacks "viewing now".

## Minor Observations
Restricted description contradicts GLOSSARY (case-access-dialog.tsx:180); disabled "Closed" in Status Select with no hint; Discussion author names wrap; "Posted message Internal" / bare "Exported" in Audit Log; "Viewing now" shows only yourself; Close Case same weight as Export; Closed banner uses amber warning; mixed date formats; dark mode signal colours hold up.

## Questions to Consider
- Why can't you tell from the Case header whether any Guest can see this Case?
- Should Timeline and Discussion share one tab?
- What does an assigned Analyst need in the first 3 seconds: attention items or four editable Selects?
