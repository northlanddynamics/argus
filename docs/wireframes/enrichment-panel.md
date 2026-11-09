# Enrichment panel: wireframes

Where a Member sees an Observable's Enrichment from anywhere in Argus: a panel that slides in from the right over the dimmed page, in place of the IP, hash, and domain/email/URL context popups. Three lookup sources now hang off hover (IPinfo for IPs, ADR 0010; VirusTotal for hashes, ADR 0011; VirusTotal for domains, email addresses and URLs, ADR 0012). Their reports have grown too tall for a popup that vanishes when the pointer slips, and analysts want to read one report beside the table it came from, compare it with the next row, and follow a value in the report to its own report.

What each source shows, and the wording of every state (looking up, never seen, no key, not configured, failed, withheld, private address), is unchanged from `ip-context-popup.md`, `hash-context-popup.md` and `domain-url-context-popup.md`. This document only moves that content into the panel and says how the panel opens, holds still and moves between values. Hover no longer opens anything.

## Behaviour

- **Opens on purpose, never on hover.** A Member opens it by:
  - the panel button (`⊟`, lucide `PanelRightOpen`) that appears beside an Observable's value when its row is pointed at or focused, as row actions do;
  - **Show Enrichment** at the top of the Observable menu (right-click or long-press on the value), with `I` as its shortcut;
  - `I` while the value has keyboard focus;
  - clicking a value that isn't a link (Bulk Lookup results, Response Action rows, an Evidence file's SHA-256). A value that is a link still opens the Observable's page, as now.
- **A Sheet over the whole page.** It is shadcn's `Sheet` on the right: full height, 420px wide, over the sidebar, header and content, whose overlay dims the whole page (stock: 10% black with a slight blur). Clicking the dimmed page or `Esc` closes it; while it is open the page behind can't be used. The page doesn't narrow.
- **One panel, swapped in place.** ↑ ↓ or following a value replaces what it shows; the panel doesn't stack. To open a value elsewhere on the page, close the panel first. The row whose value is shown is marked in the table (the selected-row fill), so the Member can see which row the report belongs to.
- **Steps through the list it came from.** `↑` `↓` buttons in the header (and `J` / `K` while focus is in the panel) move to the previous or next Enrichment-able value in the same table or chip list, skipping Assets and types with no source. Each step is a fresh lookup only if Argus has nothing cached.
- **Follows a value.** IPs, domains and hashes inside a report (Resolves to, Ends at, Mail, Nameservers) are links that open their own Enrichment in the panel, with **Back** in the header to return. History is kept for the panel's life; closing it clears it.
- **Lookup starts on open**, exactly as the popups' did: rendering a table of 200 values still costs nothing. Stepping or following a value starts the next lookup.
- **Survives a reload.** The open value is in the URL (`?enrichment=ip:185.220.101.4`, defanged values decoded), so a reload or a pasted link reopens it. Changing page closes it unless the new page has the same value.
- **Closes** on `Esc`, its `✕`, clicking the dimmed page, or opening the Observable's page. Focus returns to the value that opened it.
- **Focus.** Opening moves focus to the panel's heading, so Back, ↑ ↓ and ✕ are next, and stays in the panel while it is open; closing returns it to the value it was opened from.
- **Guests** get no panel button, no menu item and no shortcut, as they got no popup: Argus never spends the Organization's IPinfo quota or a Member's VirusTotal key for a Guest.
- **On an Observable's own page** nothing changes: the IP details and VirusTotal cards stay on the page. Values inside those cards (Resolves to, Ends at) open the panel for themselves.

## A. The panel over a Case's Observables

```
┌ sidebar ┬──────────────────────────────────────────────────────────┬──────────────────────────────────────┐
│░░░░░░░░░│░☰ │ Acme / Cases / C-12 / Observables & Assets ░░░░░░░░░░│ IP address                  ↑ ↓   ✕ │
│░░░░░░░░░├──────────────────────────────────────────────────────────┤ 185.220.101.4               [⧉] [↗] │
│░░░░░░░░░│░Observables░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░[+ Add]│ tor-exit-04.example-relay.net        │
│░░░░░░░░░│░⌂  185.220.101.4 ░░░░░░░░░░░░░░░░░░░░░░[⊟]░░░░░░3 h ago░░│ In 3 Cases · Open its page →         │
│░░░░░░░░░│░#  a3f5c8e1d2b4a6f8e0c2…░░░░░░░░░░░░░░░░░░░░░░░░░1 d ago░░├──────────────────────────────────────┤
│░░░░░░░░░│░@  billing@invoice-portal[.]biz░░░░░░░░░░░░░░░░░░1 d ago░░│ IPinfo                               │
│░░░░░░░░░│░◎  invoice-portal[.]biz░░░░░░░░░░░░░░░░░░░░░░░░░░2 d ago░░│ [Anonymous] [Hosting]                │
│░░░░░░░░░│░🔗 hxxps://invoice-portal[.]biz/login?…░░░░░░░░░░2 d ago░░│ Location   Frankfurt am Main, Hesse  │
│░░░░░░░░░│░⌂  10.20.4.17░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░2 d ago░░│ Network    AS60729 · Stiftung …      │
│░░░░░░░░░│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ as of 3 h ago             [Refresh]  │
└─────────┴──────────────────────────────────────────────────────────┴──────────────────────────────────────┘
  ↑ the whole page, sidebar and header included, is dimmed by the Sheet's overlay   ↑ 420px Sheet, full height
```

- The page keeps its layout under the overlay; the panel covers its right edge.
- The row whose value is shown keeps the selected fill and its pressed panel button, visible through the overlay.

## B. Panel anatomy

```
┌──────────────────────────────────────────┐
│ ← Back   Domain                ↑ ↓    ✕ │  ← Back only after following a value; type label (Label size,
│                                          │    muted); ↑ ↓ step through the source list, disabled at its ends
│ invoice-portal[.]biz            [⧉] [↗] │  ← the value as the popup header showed it: mono, wraps,
│                                          │    defanged; Copy; open on the source's site
│ Its domain, invoice-portal[.]biz         │  ← email only, muted
│ In 2 Cases · Open its page →             │  ← when Argus holds it as an Observable; omitted otherwise
├──────────────────────────────────────────┤
│ VirusTotal                               │  ← one section per source, Title size, in source order
│ (the source's content, A–E of its        │
│  popup wireframe)                        │
│ as of 3 h ago                [Refresh]   │  ← each section keeps its own footer, Refresh and Retry
├──────────────────────────────────────────┤
│ (next source, when a type has more than  │
│  one; none does yet)                     │
└──────────────────────────────────────────┘
       scrolls as one column below the sticky value header
```

- The header (type, value, Copy, ↗, Cases line) stays pinned while the sections scroll, so the value is always in view.
- A section's heading names its source and nothing else; the popups' "IPinfo ·" / "VirusTotal ·" footer prefix is dropped because the heading says it.
- Sections are not collapsible: with one source per type there is nothing to collapse. When a second source arrives for a type, they stack in a fixed order and each can collapse, remembered per browser.

## C. Hash

```
┌──────────────────────────────────────────┐
│ SHA-256                         ↑ ↓   ✕ │
│ a3f5c8e1d2b4a6f8e0c2d4b6a8f0e2c4d       │
│ 6b8a0f2e4c6d8b0a2f4e6c8d0b2a4f6 [⧉] [↗] │
│ Invoice_0423.pdf.exe                     │  ← meaningful name, muted
│ In 1 Case · Open its page →              │
├──────────────────────────────────────────┤
│ VirusTotal                               │
│ ┌──────────────────────────────────────┐ │
│ │ 61/69 engines flag it malicious      │ │
│ │ ██████████████████████████████░░░░   │ │
│ └──────────────────────────────────────┘ │
│ [peexe] [signed]                         │
│ Threat      trojan.emotet/generic        │
│ Detections  BitDefender Trojan.Gene…     │
│             ESET-NOD32 Win32/Emotet.CK   │
│             Kaspersky HEUR:Trojan.Win…   │
│             Microsoft Trojan:Win32/Em…   │  ← the panel has room for all of them: the first
│             and 53 more                  │    eight, in place of the popup's three
│ Type        Win32 EXE · 471 KB           │
│ Also named  invoice.exe, scan_0423.exe   │
│ Signed by   Fake Corp Ltd                │
│ First seen  20 years ago                 │
│ Analysed    7 days ago                   │
│ Community   40 malicious · 1 harmless    │
│ as of 3 h ago                [Refresh]   │
└──────────────────────────────────────────┘
```

## D. Domain, following a value

The domain report's IPs, MX hosts and nameservers are links in the panel. Following one replaces the panel's content and adds **Back**.

```
 Domain report                                   after clicking 185.220.101.4
┌──────────────────────────────────────────┐    ┌──────────────────────────────────────────┐
│ Domain                          ↑ ↓   ✕ │    │ ← Back   IP address                   ✕ │  ← ↑ ↓ hidden: the IP isn't in
│ invoice-portal[.]biz            [⧉] [↗] │    │ 185.220.101.4                   [⧉] [↗] │    the list the panel came from
│ In 2 Cases · Open its page →             │    │ In 3 Cases · Open its page →             │
├──────────────────────────────────────────┤    ├──────────────────────────────────────────┤
│ VirusTotal                               │    │ IPinfo                                   │
│ 7/93 engines flag it malicious · 1 susp. │ ─▶ │ [Anonymous] [Hosting]                    │
│ ⚠ Newly registered: 6 days ago           │    │ Location   Frankfurt am Main, Hesse      │
│ Resolves to  185.220.101.4 ↗︎             │    │ …                                        │
│              (link, opens in the panel)  │    │ as of 3 h ago                [Refresh]   │
│ Mail         mail[.]invoice-portal[.]biz │    └──────────────────────────────────────────┘
│ Nameservers  dns1[.]registrar-servers[.]com
│ …                                        │     Back returns to the domain report, at the
└──────────────────────────────────────────┘     scroll position it was left at
```

- A followed value that Argus doesn't hold as an Observable has no "In n Cases" line. (Offering **Add to Case C-12** in its place, when the panel was opened from within a Case, is not built yet.)
- A private, reserved or withheld value is still a link: its panel shows the popup's C (IP) or D (domain) state.

## E. Entry points

```
 Table row (Case Observables, Alert indicators, Bulk Lookup results, Response Actions)
┌────────────────────────────────────────────────────────────────┐
│ ⌂  185.220.101.4                              [⊟]  [⋯]  3 h ago │  ← ⊟ appears on point/focus, tooltip
└────────────────────────────────────────────────────────────────┘    "Show Enrichment (I)"

 Chip list (an Alert's extracted indicators)
 [185.220.101.4 ⊟] [invoice-portal[.]biz] [a3f5c8…]               ← ⊟ inside the pointed-at chip

 Observable menu (right-click / long-press, anywhere a value is shown)
┌──────────────────────────────┐
│ ⊟ Show Enrichment         I │  ← new, first; absent for Guests and types with no source
├──────────────────────────────┤
│ ⧉ Copy defanged              │
│ ⧉ Copy fanged                │
├──────────────────────────────┤
│ ↗ Open in VirusTotal         │
└──────────────────────────────┘

 Evidence file row
│ Invoice_0423.pdf.exe   SHA-256 a3f5c8e1…  ← the hash itself is a button that opens the panel
```

The dotted underline the popups used to hint at hover is removed. Values that link to their page keep the link's hover underline; values that open the panel get the same underline and a pointer cursor.

## F. States

Each section shows its source's states exactly as the popup wireframes word them; only the frame changes.

```
 Looking up                                    No VirusTotal key, nothing cached
┌──────────────────────────────────────────┐  ┌──────────────────────────────────────────┐
│ IP address                      ↑ ↓   ✕ │  │ SHA-256                         ↑ ↓   ✕ │
│ 185.220.101.4                   [⧉] [↗] │  │ a3f5c8e1d2b4…                   [⧉] [↗] │
├──────────────────────────────────────────┤  ├──────────────────────────────────────────┤
│ IPinfo                                   │  │ VirusTotal                               │
│ ▒▒▒▒▒▒▒▒▒▒▒▒                             │  │ No VirusTotal report yet. Each Member    │
│ ▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒             │  │ looks hashes up with their own           │
│ ▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒                  │  │ VirusTotal API key.                      │
│ looking up…                              │  │ [Add your key in Your settings]          │
└──────────────────────────────────────────┘  └──────────────────────────────────────────┘

 Failed, with a cached report                  Private address (no source section at all)
┌──────────────────────────────────────────┐  ┌──────────────────────────────────────────┐
│ Domain                          ↑ ↓   ✕ │  │ IP address                      ↑ ↓   ✕ │
│ invoice-portal[.]biz            [⧉] [↗] │  │ 10.20.4.17                         [⧉] │  ← no ↗
├──────────────────────────────────────────┤  ├──────────────────────────────────────────┤
│ VirusTotal                               │  │ Private address (10.0.0.0/8)             │
│ ┌──────────────────────────────────────┐ │  │ Not looked up: it means nothing outside  │
│ │ ⚠ VirusTotal refused your API key ·  │ │  │ the network it belongs to, and Argus     │
│ │   Your key                           │ │  │ doesn't send internal addresses to       │
│ └──────────────────────────────────────┘ │  │ IPinfo.                                  │
│ (last cached report)                     │  └──────────────────────────────────────────┘
│ as of 2 d ago                  [Retry]   │
└──────────────────────────────────────────┘
```

- The notice is the one Amber Notice treatment, inline at the top of its section.
- Stepping with ↑ ↓ while a lookup is running leaves it running; its answer is cached and shown if the Member steps back.

## G. Narrow screens

Below `md` there isn't room to dock. The panel becomes shadcn's right `Sheet`: full width, modal with the backdrop, focus trapped, and the same header, sections and Back. ↑ ↓ stay, so a Member can still walk a list on a phone.

```
┌──────────────────────────────┐
│ IP address           ↑ ↓   ✕ │
│ 185.220.101.4       [⧉] [↗] │
│ In 3 Cases · Open its page → │
├──────────────────────────────┤
│ IPinfo                       │
│ [Anonymous] [Hosting]        │
│ Location   Frankfurt am Main │
│ …                            │
└──────────────────────────────┘
```

## Open questions

- **An at-a-glance verdict in the row.** With hover gone, a table no longer hints at what a value is until the panel opens. A small, cached-only marker beside the value (for example "61/69" in the destructive tone, nothing when Argus has no report) would cost no lookups. Left out here; worth a separate wireframe if analysts miss it.
- **Width.** 420px fits the longest current rows (Detections, Network) without wrapping most values. A drag handle to widen it, remembered per browser, is easy to add later and not designed here.
