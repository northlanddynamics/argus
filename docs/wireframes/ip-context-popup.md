# IP context popup: wireframes

> These details show in two places: this hover card, on resting the pointer on an IP, and the Enrichment panel (`enrichment-panel.md`), opened on purpose. The content and wording of each state below apply to both. The hover card opens on pointer hover only; from the keyboard, `I` opens the panel instead.

What an Analyst sees on hovering (or focusing) any IP address in Argus: the IP Observables on a Case and their pages, an Alert's extracted indicators, search results, Bulk Lookup, Response Actions, and a host's IPs in its Falcon Enrichment. The details come from the Organization's IPinfo Integration (IPinfo Plus, ADR 0010) and are cached in Argus, so hovering the same address again costs no lookup.

## Behaviour

- Opens 400 ms after the pointer rests on the IP, or at once when the IP gets keyboard focus; closes 150 ms after the pointer leaves both the IP and the popup, or on Esc. The popup can be pointed into, so its buttons work.
- 320 px wide, placed below the IP and flipped above when there is no room. Never covers the IP itself.
- The IP keeps doing what it did: a link still opens the Observable's page; the popup only adds to it.
- The header shows the address as Argus shows IPs everywhere else (IPs aren't defanged), and Copy copies it.
- The lookup starts when the popup opens, not when the IP renders, so a table of 200 IPs costs nothing until someone hovers one.
- Guests get no popup: Argus never spends the Organization's IPinfo quota on their behalf.

## A. Public address, looked up

IPinfo Plus says more than fits in a card, so the card shows it a page at a time: the summary below first, then Location, Network, Privacy and, when there is anything mobile or satellite to say, Mobile. A pager between the header and the details steps through them, as the account card steps through several identities (`account-context-popup.md`); it names the page shown and where it is. The details keep one height whatever the page (and while looking up): a page longer than that scrolls inside the card, so stepping never resizes the card, flips it to the other side of the IP, or slides it out from under the pointer. The panel and an IP's own page show every page at once, as sections.

```
┌──────────────────────────────────────────────┐
│ 185.220.101.4                    [⧉] [↗]  │  ← mono; Copy; open on ipinfo.io
│ tor-exit-04.example-relay.net                │  ← reverse DNS hostname, muted; omitted if none
├──────────────────────────────────────────────┤
│ [‹]        Summary · 1 of 4            [›]  │  ← ‹ disabled on the first page, › on the last
├──────────────────────────────────────────────┤
│ [Tor] [Hosting]                              │  ← only the flags that are true; VPN, Proxy, Tor,
│                                              │    Relay in the warning tone, the rest outline
│ Location   Frankfurt am Main, Hesse          │
│            🇩🇪 Germany · Europe               │
│ Network    AS60729 · Stiftung Erneuerbare    │  ← ASN mono; name wraps
│            Freiheit                          │
│            stiftung-erneuerbare-freiheit.de  │  ← AS domain, muted
│ Type       Hosting                           │  ← AS type: ISP, Hosting, Business, Education, Government
│ Anonymiser ExampleVPN                        │  ← the anonymising service, when IPinfo names one
│ Carrier    Telekom                           │  ← a mobile address's carrier
│ Time zone  Europe/Berlin (UTC+1)             │
├──────────────────────────────────────────────┤
│ IPinfo · as of 3 h ago             [Refresh] │  ← relative, full time on hover; Refresh refetches
└──────────────────────────────────────────────┘
```

Flags, in this order and only when true: **VPN**, **Proxy**, **Tor**, **Relay** (or **Anonymous** when IPinfo says an address is anonymous but not how), **Hosting**, **Anycast**, **Mobile**, **Satellite**. With none true, the row is left out rather than showing "none".

The other pages, each replacing the summary in the same card (rows with nothing to show are left out):

```
Location · 2 of 4                     Network · 3 of 4                   Privacy · 4 of 4
City         Frankfurt am Main        ASN         AS60729               Anonymous  [Yes]
Region       Hesse (HE)               Name        Stiftung Erneuerbare  VPN        No
Postcode     60306                                Freiheit              Proxy      No
Country      🇩🇪 Germany (DE)          Domain      stiftung-…freiheit.de Tor        [Yes]
Continent    Europe (EU)              Type        Hosting               Relay      No
Coordinates  50.1155, 8.6842 ↗        Hosting     Yes                   Service    ExampleVPN
Accuracy     Within 20 km             Anycast     No
Time zone    Europe/Berlin (UTC+1)    Changed on  2 Nov 2024
Metro (DMA)  807
GeoNames ID  2925533
Changed on   14 Mar 2025

Mobile · 5 of 5   (only when the address is mobile or satellite, or IPinfo names a carrier)
Mobile       Yes
Carrier      Telekom
MCC          262
MNC          01
Satellite    No
```

Coordinates open on OpenStreetMap. "Changed on" is the day IPinfo last saw the location, or the announcing AS, change. A Yes on the Privacy page is in the warning tone.

## B. Looking up

```
┌──────────────────────────────────────────────┐
│ 185.220.101.4                    [⧉] [↗]  │
├──────────────────────────────────────────────┤
│ ▒▒▒▒▒▒▒▒▒▒▒▒                                 │  ← skeleton rows in the shape of A
│ ▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                 │
│ ▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒                      │
│ ▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                   │
├──────────────────────────────────────────────┤
│ IPinfo · looking up…                         │
└──────────────────────────────────────────────┘
```

A cached answer (even a stale one) shows at once as in A; a Refresh shows A with "refreshing…" in the footer and swaps the details in when they arrive.

## C. Private or reserved address

```
┌──────────────────────────────────────────────┐
│ 10.20.4.17                       [⧉]      │  ← no ipinfo.io link
├──────────────────────────────────────────────┤
│ Private address (10.0.0.0/8)                 │
│ Not looked up: it means nothing outside the  │
│ network it belongs to, and Argus doesn't     │
│ send internal addresses to IPinfo.           │
└──────────────────────────────────────────────┘
```

The same for loopback, link-local, documentation, multicast and other reserved ranges, naming the range. Private, shared (CGNAT) and unique-local addresses now show the hosts Falcon says last reported them instead (`ip-falcon-lookup.md`, ADR 0018); this state is what they show when the Organization has no CrowdStrike Integration.

## D. No IPinfo Integration

```
Analyst                                          Admin
┌──────────────────────────────────────────┐     ┌──────────────────────────────────────────┐
│ 185.220.101.4                [⧉] [↗]  │     │ 185.220.101.4                [⧉] [↗]  │
├──────────────────────────────────────────┤     ├──────────────────────────────────────────┤
│ No IP details: your Organization hasn't  │     │ No IP details yet.                       │
│ connected IPinfo. An Admin can add it in │     │ [Add IPinfo in Settings · Integrations]  │
│ Settings · Integrations.                 │     │                                          │
└──────────────────────────────────────────┘     └──────────────────────────────────────────┘
```

A paused IPinfo Integration reads "IPinfo is paused" with the same pointer to Settings, and still shows any cached details as in A.

## E. Lookup failed

```
┌──────────────────────────────────────────────┐
│ 185.220.101.4                    [⧉] [↗]  │
├──────────────────────────────────────────────┤
│ ⚠ IPinfo refused the API token.              │  ← IPinfo's reason, in the notice tone:
│                                              │    "refused the API token", "monthly lookup
│                                              │    quota is used up", "couldn't be reached"
│ (cached details, as in A, when Argus has any)│
├──────────────────────────────────────────────┤
│ IPinfo · as of 9 days ago            [Retry] │
└──────────────────────────────────────────────┘
```

## F. On an IP Observable's own page

The same details as the Enrichment panel, as an "IP details" card on the page above its Cases, with Refresh: the flags, then every page of A as a headed section (Location, Network with the hostname, Privacy, Mobile). No hover needed there: the page is about that IP.

```
┌ IP details ────────────────────────────────────┐
│ [Anonymous] [Hosting]                          │
│ Hostname   tor-exit-04.example-relay.net       │
│ Location   Frankfurt am Main, Hesse            │
│            🇩🇪 Germany · Europe                 │
│ Network    AS60729 · Stiftung Erneuerbare      │
│            Freiheit                            │
│ Type       Hosting                             │
│ Time zone  Europe/Berlin                       │
│ IPinfo · as of 3 h ago               [Refresh] │
└────────────────────────────────────────────────┘
```
