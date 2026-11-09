# Observables list: wireframes

A page that lists every Observable the Member can see, across the Organization, with a search box and filters: `/observables`, beside the Observable page at `/observables/$id`. Today an Observable is reached only through a Case's Observables tab, an Alert, global search or Bulk Lookup. Each of those answers a narrow question ("what's on this Case", "find me this one value", "which of these pasted values do we know"). None lets an analyst browse the Organization's Observables as a set: every domain seen in the last week, every hash on an open Case, every IP a Response Action was taken against, the newest Observables Alerts have brought in.

The page is a table, not a ranked results list. Global search jumps to one thing; this page filters a set that can be sorted, scanned, selected and copied.

## Behaviour

- **Who sees it.** Members only, as with Alerts and the Dashboard. Guests get no rail item and a 404 at the URL: they see Observables only inside their Cases.
- **What it lists.** The same rule global search uses (`apps/api/src/search/search.ts`): Observables linked to a Case the Member can see, plus Observables an Alert names. An Observable linked only to Restricted Cases the Member can't see, and named by no Alert, is not listed. Every count and Case reference in a row covers only Cases the Member can see; nothing says "and 1 more you can't see".
- **Search is indicator-aware**, with the same matching as global search: the query is refanged and normalised, so `hxxps://invoice-portal[.]biz/login` and `INVOICE-PORTAL.BIZ` both match. A domain also matches its subdomains and the URLs and email addresses on them; a URL matches URLs that start with it; the first two or three parts of an IPv4 address match that range; 8 or more hex characters match the hashes they start. Otherwise words match the start of words in the value ("invo" finds invoice-portal.biz). Results appear as the Member types (debounced), not on Enter.
- **A query sorts by best match** (exact first, then range or prefix matches, then word matches) until the Member picks another sort. Clearing the query returns to the previous sort.
- **Filters** use the shared `FilterBar` and its small selects, as the Cases list and Alert queue do:
  - **Type**: Any, IP, Domain, URL, Email, MD5, SHA-1, SHA-256 (one at a time; "Hash" isn't a type).
  - **On**: Any, Open Cases (a Case not Closed), Any Case, Alerts only (named by an Alert, linked to no Case the Member can see).
  - **Seen**: Any, Last 24 hours, Last 7 days, Last 30 days, Custom range. "Seen" is the latest of the Observable being linked to a Case or named by an Alert.
  - **Ignored**: Hide (default), Show, Only. Ignored Observables are hidden by default because they are, by definition, the ones too common to be interesting.
  - **Response Action**: Any, Has one in effect.
- **Sort** by clicking a column heading, as on the Cases list: Last seen (default, newest first), First seen, Cases, Alerts, Value (A–Z, then by type).
- **Everything is in the URL** (`/observables?q=invoice&type=domain&on=open&seen=7d&sort=cases`), so a filtered list can be shared or bookmarked, and Back returns to it.
- **Paged**, 50 rows a page, with the same Previous / Next and "51–100 of 1,284" as the search page. A new query, filter or sort goes back to page 1.
- **Live.** New Observables arriving from Alerts, or linked on a Case, don't push the rows the Member is reading. A bar at the top of the table says "4 new Observables · Show"; clicking it reloads page 1. Counts in rows already shown (Cases, Alerts, Last seen) update in place, with the brief changed-cell highlight used elsewhere.
- **Row actions** are the ones every Observable row has: the Enrichment panel button `⊟` and the Observable menu `⋯` on point or focus (`enrichment-panel.md`, E). The panel's ↑ ↓ step through this page's rows. Clicking the value opens the Observable's page.
- **Selection.** A checkbox per row and in the header. Selecting rows shows a bar with **Copy defanged**, **Copy fanged** and **Export CSV** (the selected rows, or with nothing selected, **Export CSV** in the page menu exports everything matching, up to 10,000 rows). No bulk action changes anything: adding to a Case, Ignoring and Response Actions stay on the Case and the Observable page, where their context is.
- **Entry points.**
  - A new rail item, **Observables** (lucide `Fingerprint`), after Alerts and before Dashboard.
  - Global search's dropdown: "See all 23 Observables →" under its Observables group opens `/observables?q=<query>`.
  - The Observable page's breadcrumb, when not opened from a Case: today it is a bare "Observable"; it becomes **Observables** (linking here) / Observable. Opened from a Case, it still leads back to that Case.
  - Bulk Lookup's footer: "Browse all Observables →".
- **Pasting many values.** If the query contains whitespace-separated values of two or more kinds, or more than one valid indicator, a hint under the box offers **Look these up in Bulk Lookup →** with the text carried over, since this box searches for one thing.

## A. The page

```
┌ rail ┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ▣    │ ☰ │ Acme / Observables                                                              [/ Search…]  🔔  (GJ)        │
│ 💼   ├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 🚨   │ Observables                                                                                          [⋯]         │
│ ⧉ ◀──│ 1,284 held · 37 new in the last 24 hours                                                                         │
│ 📊   │                                                                                                                  │
│      │ ┌──────────────────────────────────────────────────────────────────────────────────────────────┐                 │
│      │ │ 🔍  Search by value: an IP, domain, URL, email or hash, defanged or not                      │                 │
│      │ └──────────────────────────────────────────────────────────────────────────────────────────────┘                 │
│      │ Type [Any ▾]  On [Any ▾]  Seen [Any ▾]  Ignored [Hide ▾]  Response Action [Any ▾]                                │
│      │                                                                                                                  │
│      │ ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│      │ │ ☐  Type      Value                                    Cases                  Alerts   First seen  Last seen ▾│ │
│      │ ├──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤ │
│      │ │ ☐  ⌂ IP      185.220.101.4                [⊟] [⋯]     C-12 C-9 C-4           7        12 d ago    3 h ago    │ │
│      │ │ ☐  ◎ Domain  invoice-portal[.]biz                     C-12 C-11              2        14 d ago    5 h ago    │ │
│      │ │ ☐  @ Email   billing@invoice-portal[.]biz             C-12                   1        14 d ago    5 h ago    │ │
│      │ │ ☐  # SHA-256 a3f5c8e1d2b4a6f8e0c2…f6  ⚑ IOC in Falcon C-12                   3        20 d ago    1 d ago    │ │
│      │ │ ☐  🔗 URL    hxxps://invoice-portal[.]biz/login?…     C-12                   —        14 d ago    2 d ago    │ │
│      │ │ ☐  ⌂ IP      45.133.1.92                              —                      2        2 d ago     2 d ago    │ │
│      │ │ ☐  ◎ Domain  cdn-update[.]live                        C-8 C-7 C-6 +4         19       2 mo ago    2 d ago    │ │
│      │ │  …                                                                                                           │ │
│      │ ├──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤ │
│      │ │ 1–50 of 1,284                                                                    [‹ Previous]  [Next ›]      │ │
│      │ └──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
└──────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- The page fills the width, like the Cases list and Alert queue, because it is a table to scan across.
- The subtitle counts what the Member can see. "New" is first seen within 24 hours.
- The page menu `⋯` holds **Export CSV** (everything matching) and **Ignored Observables** (Admins, to Settings).

## B. Row anatomy

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ☐  ◎ Domain  cdn-update[.]live  [Ignored]  ⚑   [⊟] [⋯]   C-8 C-7 C-6 +4        19       2 mo ago    2 d ago     │
└─│──│─────────│──────────────────│──────────│────│────────│────────────────────│────────│───────────│────────────┘
  │  │         │                  │          │    │        │                    │        │           └ latest link or Alert,
  │  │         │                  │          │    │        │                    │        │             relative, exact on hover
  │  │         │                  │          │    │        │                    │        └ when Argus first held it
  │  │         │                  │          │    │        │                    └ Alerts that name it; "—" for none
  │  │         │                  │          │    │        └ Case refs, newest link first, at most three, then "+n";
  │  │         │                  │          │    │          each a link with the Case's title as tooltip; a Closed
  │  │         │                  │          │    │          Case's ref is muted; "—" when on Alerts only
  │  │         │                  │          │    └ Enrichment panel and Observable menu, on point/focus
  │  │         │                  │          └ ⚑ a Response Action is in effect (tooltip: "IOC in Falcon · C-12")
  │  │         │                  └ Ignored badge (muted outline), only when Ignored are shown
  │  │         └ defanged, mono, truncated in the middle for hashes and from the end for URLs; full value on hover;
  │  │           a link to the Observable's page
  │  └ type icon and label, as global search shows them
  └ selection
```

- Clicking the Cases cell's `+4` opens a small popover listing every visible Case it's on, with Status and Severity, newest link first.
- No Enrichment verdict in the row (see Open questions).

## C. Searching

```
│ ┌────────────────────────────────────────────────────────────────────────────────┐
│ │ 🔍  invoice-portal[.]biz                                                    ✕ │
│ └────────────────────────────────────────────────────────────────────────────────┘
│ Type [Any ▾]  On [Any ▾]  Seen [Any ▾]  Ignored [Hide ▾]  Response Action [Any ▾]   [✕ Clear]
│
│ ┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ │ ☐  Type      Value                                        Cases        Alerts  First seen  Last seen │  ← sorted by best match;
│ ├──────────────────────────────────────────────────────────────────────────────────────────────────────┤    no heading shows ▾
│ │ ☐  ◎ Domain  invoice-portal[.]biz                         C-12 C-11    2       14 d ago    5 h ago   │  ← exact
│ │ ☐  ◎ Domain  mail[.]invoice-portal[.]biz        subdomain C-12         1       14 d ago    5 h ago   │  ← how it matched, muted,
│ │ ☐  @ Email   billing@invoice-portal[.]biz       on it     C-12         1       14 d ago    5 h ago   │    after the value, for
│ │ ☐  🔗 URL    hxxps://invoice-portal[.]biz/login on it     C-12         —       14 d ago    2 d ago   │    anything but an exact
│ ├──────────────────────────────────────────────────────────────────────────────────────────────────────┤    or word match
│ │ 4 Observables match                                                                                  │
│ └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Match notes: **subdomain**, **on it** (a URL or email address on the domain or a subdomain), **starts with** (URL prefix, hash prefix), **in range** (IPv4 prefix).

Pasting several values:

```
│ ┌────────────────────────────────────────────────────────────────────────────────┐
│ │ 🔍  185.220.101.4 45.133.1.92 invoice-portal[.]biz                         ✕ │
│ └────────────────────────────────────────────────────────────────────────────────┘
│ ⓘ That looks like 3 values. This box finds one at a time.  Look these up in Bulk Lookup →
```

## D. Selection

```
│ ┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ │ 3 selected    [⧉ Copy defanged]  [⧉ Copy fanged]  [⤓ Export CSV]                        [✕ Clear]   │  ← replaces the column headings
│ ├──────────────────────────────────────────────────────────────────────────────────────────────────────┤    while rows are selected
│ │ ☑  ⌂ IP      185.220.101.4                                C-12 C-9 C-4   7       12 d ago    3 h ago   │
│ │ ☑  ◎ Domain  invoice-portal[.]biz                         C-12 C-11      2       14 d ago    5 h ago   │
│ │ ☐  @ Email   billing@invoice-portal[.]biz                 C-12           1       14 d ago    5 h ago   │
│ │ ☑  # SHA-256 a3f5c8e1d2b4a6f8e0c2…f6                      C-12           3       20 d ago    1 d ago   │
```

- Copy puts one value per line on the clipboard; a toast says "3 values copied".
- Selection is kept across pages (the bar says "3 selected, 1 on this page") and cleared by a new query or filter.
- The CSV has type, value (fanged), Case refs, Alert count, first seen, last seen and Ignored, for the selected rows or everything matching. Exporting is recorded in the Organization Audit Log, as a Case Report export is recorded in its Case's.

## E. States

```
 Loading                                         No Observables yet
┌────────────────────────────────────────────┐  ┌────────────────────────────────────────────┐
│ ☐  Type      Value          Cases   …      │  │                                            │
├────────────────────────────────────────────┤  │       No Observables yet                   │
│ ▒▒   ▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒   ▒▒▒▒   …      │  │  They arrive with Alerts, and Analysts     │
│ ▒▒   ▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒     ▒▒▒▒   …      │  │  add them on a Case's Observables tab.     │
│ ▒▒   ▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒  ▒▒▒▒   …      │  │                                            │
└────────────────────────────────────────────┘  └────────────────────────────────────────────┘

 No match                                        Couldn't load
┌────────────────────────────────────────────┐  ┌────────────────────────────────────────────┐
│ No Observable matches 8.8.4.4 with these   │  │ Could not load Observables.   [Retry]      │
│ filters.                                   │  └────────────────────────────────────────────┘
│ [Clear filters]  ·  It may be Ignored:     │
│ [Show Ignored]                             │   ← only when Ignored is Hide and the
└────────────────────────────────────────────┘     query would match an Ignored one
```

- The skeleton keeps the table's columns so nothing jumps when rows arrive.
- "No match" with a valid indicator doesn't offer to add it: Observables are added on a Case.

## F. Narrow screens

Below `md` the table drops to Type icon, Value and Cases; First seen, Alerts and the selection column go. Filters wrap. The Enrichment panel button stays, opening the full-width Sheet.

```
┌──────────────────────────────────┐
│ Observables                  [⋯] │
│ ┌──────────────────────────────┐ │
│ │ 🔍 Search by value           │ │
│ └──────────────────────────────┘ │
│ Type [Any ▾]  On [Any ▾]         │
│ Seen [Any ▾]  Ignored [Hide ▾]   │
├──────────────────────────────────┤
│ ⌂  185.220.101.4        C-12 +2  │
│    3 h ago                    ⊟  │
│ ◎  invoice-portal[.]biz C-12 +1  │
│    5 h ago                    ⊟  │
│ #  a3f5c8e1…f6          C-12     │
│    1 d ago                    ⊟  │
├──────────────────────────────────┤
│ 1–50 of 1,284       [‹]  [›]     │
└──────────────────────────────────┘
```

## What the API needs

- `GET /observables` with `q`, `type`, `on`, `seenFrom`, `seenTo`, `ignored`, `responseAction`, `sort`, `order`, `page`, `pageSize`; it returns the page's rows, the total and the "new in 24 hours" count. It reuses `search/indicators.ts` for the query and the access policy for visibility, so the page and global search can never disagree about what a Member may see.
- Last seen isn't stored. It is the latest of the Observable's active link times and the receipt times of the Alerts that name it, among those the Member can see; it needs an index-friendly query (or a maintained column) before this page ships on a large Organization.
- `GET /observables/export.csv` with the same parameters, writing an Organization Audit Log entry.

## Open questions

- **Assets.** Hosts and accounts are held the same way and want the same page. A sibling `/assets` with the same layout (Type: Host, Account; no Response Action filter except Containment) is the obvious follow-on. Tabs on one page ("Observables · Assets") were considered and left out: the columns differ and the rail would need a vaguer name.
- **A verdict column.** A cached-only VirusTotal ratio ("61/69", destructive tone; nothing when Argus has no report) would make the list far more useful for triage and costs no lookups. It's left out because VirusTotal reports are cached per Member key (ADR 0011), so two Members would see different columns. Decide whether a cached report is shown to everyone before adding it, and the same question applies to the Enrichment panel's open question.
- **Filter by Case Type or Tag.** "Every domain from a Phishing Case" or "everything on #bec Cases" is a natural pivot. It needs the On filter to grow from a select into a Case picker; deferred until analysts ask.
- **Saved views.** The URL holds the whole state, so a bookmark already works. Named, shared views (like the Cases list's views) can come later.
