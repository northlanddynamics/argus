---
target: observable list page, details page and search
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/user/argus/apps/web/src/routes/cases/observables.tsx"
target_fingerprint: "sha256:d583e65932bbf6e1f067f6e67c4b7a5cd3b73cadc073996116026f9f10321a04"
target_path: /home/user/argus/apps/web/src/routes/cases/observables.tsx
timestamp: 2026-11-06T20-29-46Z
slug: src-routes-cases-observables-tsx
---
# Critique: Observable list, Observable page, Search
Method: dual-agent (design review + detector/browser). Score 25/40 (Acceptable).

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | LinkedCard (observables.tsx) has no loading/error row |
| 2 | Match System / Real World | 2 | Search can't find partial IPs, hash prefixes or defanged URLs the UI shows |
| 3 | User Control and Freedom | 3 | Org-wide Ignore and Unlink are one click, no confirm or undo |
| 4 | Consistency and Standards | 2 | ⋯ menu vs inline Unlink; h1 sizes; 4xl/5xl/6xl widths; 13px mono off-ramp |
| 5 | Error Prevention | 2 | Ignored state invisible on list and search; type Select doesn't detect pasted type |
| 6 | Recognition Rather Than Recall | 3 | Must remember Ignored values and expand shortened hashes |
| 7 | Flexibility and Efficiency | 3 | No prefix/CIDR search, no "search this value" from a row |
| 8 | Aesthetic and Minimalist Design | 3 | Empty tables with full headers; value is smallest text in its row |
| 9 | Error Recovery | 2 | "Nothing matches" has no next step; add error not tied to input |
| 10 | Help and Documentation | 2 | Syntax hint omits whole-token matching |

Priority issues:
- [P1] Search can't find what the UI shows (partial IP, hash prefix e3b0, defanged URL, ?q=185.220 parsed as number). Fix API prefix match + refang; helpful empty state; parse q as string.
- [P1] Ignored invisible outside the Observable page (list rows, search hits, palette). Reuse the BellOff "Ignored" badge.
- [P2] "Seen in other Cases" shows C-2 but opens the Observable page. Link the Case or relabel.
- [P2] Cross-surface inconsistency: Assets inline Unlink vs ⋯ menu; item h1 mono text-xl; widths 4xl/5xl/6xl; 13px mono in search-hit.tsx:117,127; breadcrumb loses originating Case.
- [P3] Value is smallest text in its row (12px mono vs 14px Type); LinkedCard missing states; palette muted text 4.3:1 on selected row.

Detector: CLI clean except design-system-font-size x2 (search-hit.tsx:117,127). Overlay: 3 low-contrast in palette (C-2 ref, status line, Kbd hint; Kbd is stock and a false positive in spirit).
