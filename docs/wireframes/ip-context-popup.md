# IP context popup: wireframes

What an Analyst sees on hovering (or focusing) any IP address in Argus: the IP Observables on a Case and their pages, an Alert's extracted indicators, search results, Bulk Lookup, Response Actions, and a host's IPs in its Falcon Enrichment. The details come from the Organization's IPinfo Integration (IPinfo Core, ADR 0010) and are cached in Argus, so hovering the same address again costs no lookup.

## Behaviour

- Opens 400 ms after the pointer rests on the IP, or at once when the IP gets keyboard focus; closes 150 ms after the pointer leaves both the IP and the popup, or on Esc. The popup can be pointed into, so its buttons work.
- 320 px wide, placed below the IP and flipped above when there is no room. Never covers the IP itself.
- The IP keeps doing what it did: a link still opens the Observable's page; the popup only adds to it.
- The header always shows the address **defanged**, as everywhere else in Argus, and Copy copies it defanged.
- The lookup starts when the popup opens, not when the IP renders, so a table of 200 IPs costs nothing until someone hovers one.
- Guests get no popup: Argus never spends the Organization's IPinfo quota on their behalf.

## A. Public address, looked up

```
┌──────────────────────────────────────────────┐
│ 185.220.101[.]4                    [⧉] [↗]  │  ← mono; Copy (defanged); open on ipinfo.io
│ tor-exit-04.example-relay.net                │  ← reverse DNS hostname, muted; omitted if none
├──────────────────────────────────────────────┤
│ [Anonymous] [Hosting]                        │  ← only the flags that are true; Anonymous in
│                                              │    the warning tone, the rest neutral outline
│ Location   Frankfurt am Main, Hesse          │
│            🇩🇪 Germany · Europe               │
│ Network    AS60729 · Stiftung Erneuerbare    │  ← ASN mono; name wraps
│            Freiheit                          │
│            stiftung-erneuerbare-freiheit.de  │  ← AS domain, muted
│ Type       Hosting                           │  ← AS type: ISP, Hosting, Business, Education, Government
│ Time zone  Europe/Berlin (UTC+1)             │
├──────────────────────────────────────────────┤
│ IPinfo · as of 3 h ago             [Refresh] │  ← relative, full time on hover; Refresh refetches
└──────────────────────────────────────────────┘
```

Flags, in this order and only when true: **Anonymous** (VPN, proxy, Tor or relay; IPinfo Core says only that it is, not which), **Hosting**, **Anycast**, **Mobile**, **Satellite**. With none true, the row is left out rather than showing "none".

## B. Looking up

```
┌──────────────────────────────────────────────┐
│ 185.220.101[.]4                    [⧉] [↗]  │
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
│ 10.20.4[.]17                       [⧉]      │  ← no ipinfo.io link
├──────────────────────────────────────────────┤
│ Private address (10.0.0.0/8)                 │
│ Not looked up: it means nothing outside the  │
│ network it belongs to, and Argus doesn't     │
│ send internal addresses to IPinfo.           │
└──────────────────────────────────────────────┘
```

The same for loopback, link-local, CGNAT, documentation, multicast and other reserved ranges, naming the range.

## D. No IPinfo Integration

```
Analyst                                          Admin
┌──────────────────────────────────────────┐     ┌──────────────────────────────────────────┐
│ 185.220.101[.]4                [⧉] [↗]  │     │ 185.220.101[.]4                [⧉] [↗]  │
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
│ 185.220.101[.]4                    [⧉] [↗]  │
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

The same details as A, as a card in the page's side column under "IP details", with Refresh. No hover needed there: the page is about that IP.

```
┌ IP details ──────────────────────── [Refresh] ┐
│ [Anonymous] [Hosting]                          │
│ Hostname   tor-exit-04.example-relay.net       │
│ Location   Frankfurt am Main, Hesse            │
│            🇩🇪 Germany · Europe                 │
│ Network    AS60729 · Stiftung Erneuerbare      │
│            Freiheit                            │
│ Type       Hosting                             │
│ Time zone  Europe/Berlin                       │
│ IPinfo · as of 3 h ago                         │
└────────────────────────────────────────────────┘
```
