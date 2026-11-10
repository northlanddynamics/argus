---
target: action center
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/user/argus/apps/web/src/routes/action-center.tsx"
target_fingerprint: "sha256:f4847a91c7f52a0aae537089827044961314d1f70a87815a950c501da7b80515"
target_path: /home/user/argus/apps/web/src/routes/action-center.tsx
timestamp: 2026-11-10T13-26-36Z
slug: apps-web-src-routes-action-center-tsx
---
Method: dual-agent (A: design review · B: detector/browser)

## Design Health Score: 24/40 (Acceptable)
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Run toast flattens per-value outcomes ("2 values done" when one was unchanged) |
| 2 | Match System / Real World | 2 | "IOC alert" / "IOC block" collide with GLOSSARY (IOC, Alert); block-wording reason placeholder on detect-only action |
| 3 | User Control and Freedom | 3 | Enter in Value silently opens the first ready Respond action |
| 4 | Consistency and Standards | 2 | Dashed "Admin" badge, Focus Indigo as match signal, Live Green/Reconnecting Amber reused for run status, toggle filters instead of selects |
| 5 | Error Prevention | 3 | "Run…" enabled on blocked cards; private IPs listed as runnable |
| 6 | Recognition Rather Than Recall | 3 | Types, Integration and status shown on every card |
| 7 | Flexibility and Efficiency | 2 | No j/k, 13 Run tab stops, no chaining one value through several actions |
| 8 | Aesthetic and Minimalist Design | 2 | 9 of 13 cards unavailable with one Integration; working set buried |
| 9 | Error Recovery | 2 | Blocked state discovered only inside the dialog, no route to fix; catalogue error has no retry |
| 10 | Help and Documentation | 2 | No link to Integration settings or who can enable containment |

## Design Specificity Verdict
LLM: decisions are Argus-specific (Respond / Look up / Mark with reversibility notes, reason "sent to CrowdStrike in place of a Case's reference", Ignored and relying-Case confirmations, containment routed to the Case). The layout is generic: 13 equal cards each with "Run…", uppercase tracked group labels, a SOAR-marketplace grid.
Deterministic scan: 0 findings (CLI on action-center.tsx and lib/action-center.ts; in-page overlay "No anti-patterns found"). No overflow, console errors or unlabelled controls at 1440/390 in both themes. URL-mode detect timed out (no session).

## Priority Issues
1. [P1] Partial outcomes flattened in the toast (action-center.tsx:307). Unchanged/failed values count as "done". Fix: keep the dialog open on a per-value result list grouped by outcome, Amber Notice when any value skipped/unchanged/failed; toast only on full success. -> /impeccable harden
2. [P1] Possible Restricted-Case leak in remove confirmation (:613-614): "2 Cases you can't see record it as present". Fix: drop the count or have the server refuse and route to an Admin; confirm with product. -> /impeccable harden
3. [P1] Matched/blocked states mislead and signal tokens are reused (:180, :202, :205): focus ring as match marker regardless of runnability, opacity-55 dims below contrast, Run… enabled on blocked cards, Live Green as Ready. Fix: runnable matches first, fold unavailable into "Not available (n)" with reasons and settings link, text badge for match, no opacity dimming, own status token. -> /impeccable distill + /impeccable polish
4. [P2] Enter default biased toward a write (:128): first ready match excludes containment but still picks IOC alert before File reputation. Fix: prefer the first lookup and show the default ("Enter: File reputation"). -> /impeccable clarify
5. [P2] Action Log ignores DESIGN table/filter rules: no colgroup or column drop (Case and State scroll off on phone), When as first column, 7 toggles with two "All"s, "7 runs" counts per-value rows, Link to Case… duplicated. -> /impeccable layout

## Persona Red Flags
Alex: 13 tab stops through the grid, no j/k; can't run one value through several actions; invisible Enter default; lookup "Done" ends the flow.
Sam: match conveyed only by ring/opacity; Run aria-label omits match/runnability; disabled submit explained only by title; 55% opacity fails contrast; tablist div focusable with no visible outline (B heuristic, unconfirmed).
Triaging Analyst: Case unset by default so every run needs a reason; no preselect of the open Case; log can't filter by Case or "me" though API supports `by`; "IOC alert" beside real Alerts.

## Minor Observations
"State" column vs Status/outcome; "Dismiss record" reads as erasure; solid black "2 new" tab badge is the loudest element; uppercase group headings off the type scale; cards are 10px li not Card; private IPs not marked skipped in IP details; configuration blocks use Amber Notice; Action Log tab has no heading; document.title stays "Argus"; long Value placeholder truncates; API: detect without integrationIds 500s (response-actions.ts:1005).

## Questions to Consider
- Lead with the value: show only the input until something is pasted, then the 2-4 actions that can run?
- If the Case is the record, why does a run default to no Case?
- Is the Action Log a ledger or a worklist? Would a "Needs attention" default view serve triage better?
