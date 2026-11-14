# Alert queue and Alert panel: review and wireframes

A review of the Alert queue (`apps/web/src/routes/alerts/queue.tsx`) and the Alert panel it shares with a Case's Alerts flyout (`alert-details.tsx`, `cases/alerts-panel.tsx`), as of 2026-11-14, with wireframes for what should change.

Most of the 2026-11-04 critique has been acted on: loading and error states, keyboard triage (`j` `k` `x` `o` `a` `d` `Esc`), shift-range selection, the quieter selection toolbar in the header row, "Alert" for "Detection", focus return, refusal titles. What is left is less about polish and more about **what the screens show**: the queue spends its columns on things that don't help an Analyst decide, and the panel keeps what happened on the host inside the Raw payload.

## Findings

### Queue

| # | Finding | Where | Change |
|---|---|---|---|
| Q1 | The Alert Status column says **New** on every row of the default view (the queue opens on New), so the widest right-hand column carries nothing. The Related Case, the one cue that says "this belongs with C-12", sits under it in muted 12px text. | `queue.tsx:494`, `:596-617` | Status column only when the Alert Status filter is Any. In its place a **Related Case** column with the Case and a one-click **Attach** (A). |
| Q2 | Nothing in a row says what the detection did or whether Falcon stopped it. Tactic, Technique and the disposition (`PatternDispositionDescription`: "Prevention, process killed.") are in every EPP payload; Tactic and Technique in IdP ones. "Blocked" vs "only detected" is the first triage question. | row, `queue.tsx:541-570` | Subline gains **Tactic › Technique**; a **Prevented** chip when the disposition is a prevention (A). Server pulls these out of the payload as it does `FalconHostLink`. |
| Q3 | A burst from one host is 20 rows of the same host, each to be read, selected and actioned. Shift-range helps only when they happen to be adjacent. | whole table | **Group by host / account** toggle: one row per subject with count, highest Severity, time span; expanding shows its Alerts; its checkbox selects them all (B). |
| Q4 | Only one order (received, newest first). An Analyst coming back to 60 New Alerts wants the Criticals first. | `alerts.ts:654` | **Sort: Newest · Severity** in the filter bar; Severity sorts Critical→Info, then newest. |
| Q5 | No way to find Alerts by host, account, title or Falcon id; only by Case. "Everything on FIN-LT-0231" means paging. | filter bar | A **Search** field (host, account, title, external id). |
| Q6 | Rows show when Argus received the Alert, not when Falcon detected it. The row data already carries `detectedAt` and drops it. A detection that arrives hours late looks fresh. | `queue.tsx:593` | Show **Detected** time; when received is over 15 min later, a muted "received 2 h later" under it. |
| Q7 | The shortcut legend is a permanent two-line sentence under the table. | `queue.tsx:673-676` | A `?` button in the footer and `?` key opening a shortcut list, as one line: "Keyboard shortcuts ?" |
| Q8 | Selecting an Alert and opening it are two places (checkbox, title). With the panel open `j`/`k` move focus in the list but the panel keeps showing the old Alert. | `queue.tsx:116-122` | While the panel is open, `j`/`k` (and ↑ ↓ in the panel header) step the panel to the next Alert, as the Enrichment panel does (C). |

### Panel (queue side panel and Case flyout)

| # | Finding | Where | Change |
|---|---|---|---|
| P1 | **What happened is only in Raw payload.** The process chain (Explorer › WINWORD › powershell -enc …), the command line, the file written (stage2.exe), the connections (185.220.101.4:443) and the disposition are in the JSON blob at the bottom. For IdP: source account and host, target account, target service, source IP reputation, location. | `alert-details.tsx:349-352` | A **What happened** section second from the top, per Alert kind (D, E). Raw payload stays, last, with Copy. |
| P2 | The decision buttons (Open Case, Attach, Dismiss) are after Related Cases, Falcon comments and Raw payload: on a real Alert they are a scroll away. | `alert-details.tsx:353-387` | A sticky action bar at the panel's foot (C). |
| P3 | Related Cases, the main input to Attach vs Open Case, comes after the extracted indicators. | `alert-details.tsx:345` | Directly under What happened; a single strong match shows inline with the header ("Shares 3 with C-12") (C). |
| P4 | Falcon's mirrored status, assignee and tags sit in the same list as Host, User and Received, though GLOSSARY says they are not the Alert's own. | `alert-details.tsx:304-330` | Their own **In Falcon** group with the comments, below (C). |
| P5 | Extracted Observables are one flat chip list; nothing says which are Important, though only Important ones drive Correlation (ADR 0015). | `alert-details.tsx:91-117` | Group by type; an **Important** badge on Important ones (C). |
| P6 | The header shows Severity and Alert Status but not Tactic, disposition or when it was detected. | `alert-details.tsx:270-297` | Header meta line: `Tactic › Technique · Prevented · detected 14:03` (C). |
| P7 | Queue panel and Case flyout differ in width (26rem min vs 30rem) and in how they close; the Case one is a Sheet, the queue one a column. Fine as is, but step buttons (↑ ↓) belong in both. | `queue.tsx:444`, `alerts-panel.tsx:93` | Same header in both: ↑ ↓ ✕. |

## A. Queue row, New Alerts (default view)

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Alerts                                                                                                      │
│ CrowdStrike — Prod: Connected, last event 12 s ago                                                          │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ [🔍 Host, account, title or id    ] Alert Status [New ▾] Severity [Any ▾] Attached to [C-1041] Falcon Complete [Hidden ▾]  Sort [Newest ▾] [Group by host] │
├────┬──────────┬───────────────────────────────────────────────┬──────────────────┬───────────┬────────────────────┤
│ ☐  │ Severity │ Alert                                         │ Host / account   │ Detected  │ Related Case       │
├────┼──────────┼───────────────────────────────────────────────┼──────────────────┼───────────┼────────────────────┤
│ ☐  │ ▌High    │ EncodedPowerShellFromOffice      [Prevented]  │ ⌂ FIN-LT-0231    │ 14:03     │ C-12 Invoice phish │
│    │          │ ldt:8f1c…:41 · Endpoint · Execution › PowerShell │ @ d.howe     │           │ 3 shared  [Attach] │
├────┼──────────┼───────────────────────────────────────────────┼──────────────────┼───────────┼────────────────────┤
│ ☐  │  Medium  │ Unusual login to an endpoint                  │ ⌂ FIN-LT-0231    │ 14:01     │ C-12 +1 more       │
│    │          │ A1E0-07C4 · Identity · Initial Access › Valid Accounts │ @ d.howe│ received  │ 2 shared  [Attach] │
│    │          │                                               │                  │ 2 h later │                    │
├────┼──────────┼───────────────────────────────────────────────┼──────────────────┼───────────┼────────────────────┤
│ ☐  │  Low     │ PUP installer blocked            [Prevented]  │ ⌂ MKT-LT-0110    │ 13:47     │ —                  │
│    │          │ ldt:71aa:11 · Endpoint · Persistence › …      │                  │           │                    │
└────┴──────────┴───────────────────────────────────────────────┴──────────────────┴───────────┴────────────────────┘
  1–50 of 64 New Alerts, newest first                    ‹ Newer   Page 1 of 2   Older ›      Keyboard shortcuts ?
```

- **Related Case** replaces Alert Status while the filter is New. With Alert Status Any, Attached or Dismissed, the column is Alert Status as now (badge, Case ref, Dismissal Reason) and Related moves back to a subline.
- **Attach** in the cell attaches to that Case straight away, with the same version check and refusal notice as the toolbar's Attach; it doesn't open a dialog. A Closed related Case shows "Closed" and no button (Admins: "Reopen and attach").
- **[Prevented]** is an outline chip, Label size, shown only when the disposition is a prevention (process killed, blocked, quarantined). Nothing is shown for detect-only: the absence is the signal, and a second chip on every row would be noise.
- **Tactic › Technique** follows the kind in the subline, muted, truncating first when narrow.
- **Detected** is `detectedAt`, falling back to received when Falcon gave none. Hover shows both exact times.
- Narrow (panel open): Host / account and Detected fold into the subline as now; Related Case stays, since it is what the panel's actions act on.

## B. Grouped by host / account

`Group by host` groups every Alert matching the filters, not just the page's 50, by the Alert's host, else its account.

```
├────┬──────────┬───────────────────────────────────────────────┬──────────────────┬───────────┬────────────────────┤
│ ☐  │ ▌High    │ ▾ ⌂ FIN-LT-0231 · @ d.howe       12 Alerts    │                  │ 13:12–14:03│ C-12 Invoice phish│
│    │          │   High 2 · Medium 7 · Low 3                    │                  │           │ 11 of 12 share     │
├────┼──────────┼───────────────────────────────────────────────┼──────────────────┼───────────┼────────────────────┤
│  ☐ │ ▌High    │   EncodedPowerShellFromOffice    [Prevented]  │                  │ 14:03     │ C-12  [Attach]     │
│  ☐ │  Medium  │   Unusual login to an endpoint                │                  │ 14:01     │ C-12  [Attach]     │
│    │          │   … 10 more                                    │                  │           │                    │
├────┼──────────┼───────────────────────────────────────────────┼──────────────────┼───────────┼────────────────────┤
│ ☐  │  Low     │ ▸ ⌂ MKT-LT-0110                   1 Alert     │                  │ 13:47     │ —                  │
└────┴──────────┴───────────────────────────────────────────────┴──────────────────┴───────────┴────────────────────┘
```

- Groups are ordered by their highest Severity, then newest. The group's Severity is its highest.
- The group checkbox selects every Alert in the group, including any not yet expanded; the toolbar count says so ("12 selected").
- Groups start collapsed except the first; `Enter` on a group row expands it, `x` selects it.
- The Host / account column is empty inside a group: the group row names it.
- Turning grouping on or off keeps the selection. It is in the URL (`?group=subject`).
- Needs a server endpoint that groups the filtered Alerts; grouping one page of 50 client-side would split groups across pages.

## C. Alert panel

Same content in the queue's side panel and a Case's Alerts flyout.

```
┌──────────────────────────────────────────────┐
│ ▌High  New                         ↑ ↓   ✕  │  ← ↑ ↓ step through the queue (or the Case's
│                                              │    Alerts); j / k do the same while the panel
│ EncodedPowerShellFromOffice                  │    is open
│ Execution › PowerShell · [Prevented]         │  ← Tactic › Technique; disposition chip
│ ldt:8f1c…:41 · Endpoint · CrowdStrike — Prod │
│ Detected 14:03:12 · received 14:03:15        │
│                                              │
│ ┌ Shares 3 with C-12 Invoice phish [Attach]┐ │  ← the strongest Related Case, when there is one
│ └──────────────────────────────────────────┘ │
│                                              │
│ A process launched PowerShell with an        │
│ encoded command line from an Office app.     │
│                                              │
│ Host   ⌂ FIN-LT-0231   10.20.4.17 · Windows  │
│ User   @ d.howe        ACME                  │
├──────────────────────────────────────────────┤
│ What happened                                │  ← D (EPP) or E (Identity)
│ …                                            │
├──────────────────────────────────────────────┤
│ Related Cases                                │  ← as now: each Case, its shared Observables
│ C-12 Invoice phish  In Progress   3 shared   │    and Assets, Attach
│ [⌂ FIN-LT-0231] [⌂ 185.220.101.4] [# 7f3a…]  │
│ [Attach to C-12]                             │
│ C-9  Tor egress review  Closed    1 shared   │
├──────────────────────────────────────────────┤
│ Extracted                                    │
│ IP        185.220.101.4 [Important] ⊟        │  ← grouped by type; Important badge on the ones
│ Domain    invoice-portal[.]biz ⊟             │    that drive Correlation
│ SHA-256   7f3a9c0e…9d1c91 ⊟                  │
│ Host      ⌂ FIN-LT-0231                      │
│ Account   @ d.howe                           │
│ Attaching this Alert adds these to its Case. │
├──────────────────────────────────────────────┤
│ In Falcon                                    │  ← Falcon's own status, assignee, tags and
│ Status    New        Assignee  —             │    comments, together and below the Alert's own
│ Tags      —                                  │
│ Comments  None · fetched 14:05               │
├──────────────────────────────────────────────┤
│ ▸ Raw payload                        [⧉ Copy]│
╞══════════════════════════════════════════════╡
│ [Open Case]  [Attach to Case…]  [Dismiss…]   │  ← sticky at the foot; Move / Detach when attached
└──────────────────────────────────────────────┘
```

- The strongest Related Case in the header duplicates the first entry of Related Cases on purpose: on most Alerts it is the whole decision, and it should be readable without scrolling. Not shown when there is no Related Case or when the Alert is already Attached.
- The action bar is sticky in both the side panel (which scrolls on its own) and the Sheet. Attached Alerts show **Move to another Case…** and **Detach**; Dismissed ones show nothing and the bar is hidden.
- ↑ ↓ keep the queue's selection as it is; the row shown is marked with the selected-row fill as now.
- Host line adds the local IP and platform from the payload; User adds the logon domain. Both only when present.

## D. What happened: Endpoint (EPP)

```
│ What happened                                │
│                                              │
│ Process                                      │
│   explorer.exe                               │
│   └ WINWORD.EXE                              │
│     /n "C:\Users\d.howe\Downloads\invoice-   │
│     0923.docm"                               │
│     └ powershell.exe                ▌Flagged │  ← the process the detection is about
│       -nop -w hidden -enc JABzAD0ATgBl…      │  ← command line, mono, 3 lines then "Show all"
│       [Decode base64]                        │  ← only when it carries -enc / -EncodedCommand
│                                              │
│ Outcome      Prevention, process killed      │
│ File         powershell.exe   # 7f3a9c0e… ⊟  │
│              C:\Windows\System32\Windows…    │
│ Wrote        stage2.exe                      │
│              C:\Users\d.howe\AppData\Local\… │
│ Opened       invoice-0923.docm               │
│ Connected    ⌂ 185.220.101.4:443 TCP  ×2  ⊟  │
│ Looked up    ◎ invoice-portal[.]biz  A    ⊟  │
│ Objective    Gain Access                     │
```

- Built from the payload fields CrowdStrike sends: `GrandParent*`, `Parent*`, `FileName`/`FilePath`/`CommandLine`, `PatternDispositionDescription`, `SHA256String`, `ExecutablesWritten`, `DocumentsAccessed`, `NetworkAccesses`, `DnsRequests`, `Objective`.
- Device paths (`\Device\HarddiskVolume3\…`) show as drive paths where the volume maps to `C:`, else as sent.
- Values that are Observables (IP, domain, hash) are ItemValues: hover card, Enrichment button, menu.
- Repeated connections to the same address and port collapse to one line with a count.
- **Decode base64** shows the decoded command beneath, mono, read-only; it never runs anything.
- A row with nothing to show is omitted; with none at all the section is omitted.

## E. What happened: Identity

```
│ What happened                                │
│                                              │
│  @ d.howe            ──▶   @ svc-backup      │  ← source account → target account
│  ⌂ FIN-LT-0231             ⌂ DC01.acme.corp  │  ← source host → target host
│  185.220.101.4 ⊟           cifs/DC01…        │  ← source IP → target service
│  [Suspicious IP] Frankfurt, DE               │  ← IP reputation chip, location
│                                              │
│ Between      13:59:20 – 14:00:20             │  ← StartTime – EndTime
│ Previous     activity 1 day before           │  ← PrecedingActivityTimestamp
│ Policy rule  —                               │
```

- Source and target are Assets when Argus holds them, with their hover cards (Identity Protection identity for accounts).
- `[Suspicious IP]` uses the notice colours; a clean reputation shows nothing.

## Not changing

- The selection toolbar in the header row, version-pinned selection, and the refusal notice with **Select these again**.
- Drag to a work-queue Case to attach.
- Pagination, Falcon Complete hiding, the Case filter.
- The Integration health line and notice.
