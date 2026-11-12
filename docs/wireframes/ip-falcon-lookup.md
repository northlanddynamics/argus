# Internal IP looked up in Falcon: wireframes

> With ADR 0018. Replaces state C of `ip-context-popup.md` for private, shared (100.64/10) and unique-local addresses. Loopback, link-local, multicast, documentation and other reserved addresses keep state C unchanged. Public addresses are unchanged.

What a Member sees on hovering an internal IP, or opening it in the Enrichment panel: the hosts that each of the Organization's CrowdStrike Integrations says last reported that address. The behaviour (when the card opens and closes, Guests, where IPs are hoverable) is `ip-context-popup.md`'s. The panel's frame (header, ↑ ↓, Back, sections) is `enrichment-panel.md`'s.

## Behaviour

- **The range moves to the header.** "Private address · 10.0.0.0/8" sits under the value, muted, where a public IP's reverse DNS name goes. There's still no ↗ to ipinfo.io, and no IPinfo section.
- **One section per CrowdStrike Integration.** With a single Integration the heading is "CrowdStrike". With several, each heading carries the Integration's name ("CrowdStrike · EU tenant"), in the order Settings lists them.
- **Hosts newest first** by last seen. The hover card shows up to 3 and "and N more · Show all (I)"; the panel shows every one Argus fetched (at most 50), then "Falcon matched 212; showing the 50 seen most recently" when there are more.
- **A host's name links to its Asset page** when its `aid` is recorded on a host Asset (and the panel marks it "Held as a host"). Every host has ↗ to the device in the Falcon console.
- **Wording is always "last reported"**: never "this is" or "owned by".
- **Stale hosts are dimmed.** A host last seen over 7 days ago is muted, with "last seen 23 days ago — may have moved on". The address may have been leased again since.
- **Lookup starts on open**, as now: a table of 200 internal IPs costs nothing until one is hovered.

## A. One host (hover card)

```
┌──────────────────────────────────────────────┐
│ 10.20.4.17                            [⧉]    │  ← no ↗: nothing on ipinfo.io for it
│ Private address · 10.0.0.0/8                 │  ← muted
├──────────────────────────────────────────────┤
│ Last reported by                             │  ← muted, Label size
│ ▣ WS-FIN-0412                     [↗]        │  ← hostname: link to its Asset page if Argus
│   Windows 11 · last seen 4 min ago           │    holds it, else ↗ to the Falcon console
│   jdoe@acme.corp                             │  ← last logged-on user, mono, muted
│   [Contained]                                │  ← only when not normal; destructive tone
├──────────────────────────────────────────────┤
│ CrowdStrike · as of 2 min ago     [Refresh]  │
└──────────────────────────────────────────────┘
```

## B. Several hosts (hover card)

```
┌──────────────────────────────────────────────┐
│ 172.17.0.1                            [⧉]    │
│ Private address · 172.16.0.0/12              │
├──────────────────────────────────────────────┤
│ Last reported by 14 hosts                    │
│ ▣ BUILD-AGENT-07     Linux · 2 min ago       │
│ ▣ DEV-MBP-ALEE       macOS · 1 h ago         │
│ ▣ BUILD-AGENT-03     Linux · 3 h ago         │
│   and 11 more · Show all (I)                 │  ← opens the panel on this IP
├──────────────────────────────────────────────┤
│ ⓘ Many hosts share this address; it is       │  ← only with 5 or more: likely a NAT, VPN
│   likely reused on each one.                 │    pool or a default like Docker's bridge
├──────────────────────────────────────────────┤
│ CrowdStrike · as of 2 min ago     [Refresh]  │
└──────────────────────────────────────────────┘
```

## C. In the Enrichment panel

```
┌──────────────────────────────────────────┐
│ IP address                      ↑ ↓   ✕ │
│ 10.20.4.17                         [⧉]  │
│ Private address · 10.0.0.0/8             │
│ In 1 Case · Open its page →              │
├──────────────────────────────────────────┤
│ CrowdStrike                              │
│ Last reported by                         │
│ ┌──────────────────────────────────────┐ │
│ │ WS-FIN-0412 ↗        [Held as a host] │ │  ← badge when held as a host Asset
│ │ Platform    Windows 11 23H2          │ │
│ │ Last seen   4 min ago                │ │
│ │ User        jdoe@acme.corp           │ │
│ │ MAC         00-1A-2B-3C-4D-5E        │ │
│ │ Site / OU   London · Finance         │ │
│ │ Groups      Finance Workstations     │ │
│ │ Sensor      7.18 · Normal            │ │
│ │ Containment Normal                   │ │
│ │ [+ Add host to C-12]                 │ │  ← only when opened from within a Case and the
│ └──────────────────────────────────────┘ │    host isn't linked to it; not built yet
│ as of 2 min ago              [Refresh]   │
└──────────────────────────────────────────┘
```

Several hosts stack as cards like the one above, newest first. Each is collapsed to its first two rows (hostname, platform and last seen) when there are more than 3, and expands on click.

## D. States

```
 Looking up                                    Not found
┌──────────────────────────────────────────┐  ┌──────────────────────────────────────────┐
│ 10.20.4.17                         [⧉]  │  │ 10.20.4.17                         [⧉]  │
│ Private address · 10.0.0.0/8             │  │ Private address · 10.0.0.0/8             │
├──────────────────────────────────────────┤  ├──────────────────────────────────────────┤
│ ▒▒▒▒▒▒▒▒▒▒▒▒                             │  │ No host in Falcon last reported this     │
│ ▒▒▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒                 │  │ address. It may be a device without a    │
│ ▒▒▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒                    │  │ sensor (a server, printer or phone), or  │
├──────────────────────────────────────────┤  │ the host that had it has moved on.       │
│ CrowdStrike · looking up…                │  ├──────────────────────────────────────────┤
└──────────────────────────────────────────┘  │ CrowdStrike · as of just now  [Refresh]  │
                                              └──────────────────────────────────────────┘

 No CrowdStrike Integration                    Failed, with a cached answer
┌──────────────────────────────────────────┐  ┌──────────────────────────────────────────┐
│ 10.20.4.17                         [⧉]  │  │ 10.20.4.17                         [⧉]  │
│ Private address · 10.0.0.0/8             │  │ Private address · 10.0.0.0/8             │
├──────────────────────────────────────────┤  ├──────────────────────────────────────────┤
│ Not looked up: it means nothing outside  │  │ ⚠ The API client lacks the Hosts: Read   │  ← Falcon's reason, Amber Notice:
│ the network it belongs to, and Argus     │  │   scope.                                 │    "lacks the Hosts: Read scope",
│ doesn't send internal addresses to       │  │ (last cached hosts, as in A or B)        │    "couldn't be reached", "refused
│ IPinfo.                                  │  ├──────────────────────────────────────────┤    the API client"
└──────────────────────────────────────────┘  │ CrowdStrike · as of 2 h ago     [Retry]  │
  ← today's state C, word for word            └──────────────────────────────────────────┘
```

- **Paused** Integration: its cached hosts, footer "CrowdStrike is paused", no Refresh. With nothing cached, "CrowdStrike is paused, so nothing is looked up" and, for Admins, the Settings · Integrations button, as IPinfo's state D does.
- **Several Integrations**, one failing: each section shows its own state; one failing doesn't hide the others.

## E. On an IP Observable's own page

An internal IP's page shows a "Hosts in Falcon" card in place of "IP details", with C's content and Refresh. Its hosts link as in C.

## Open questions

- **"At the time of the Alert."** When the panel is opened from an Alert whose detection names a device with this address, that device is the one that had it then. Pinning it first, as "On this Alert: WS-FIN-0412 at 14:02", would answer the question Analysts usually mean. It needs the Alert passed as context to the panel, which nothing does yet.
- **The many-hosts threshold** (5) is a guess. Docker's 172.17.0.1 will match every Linux build host, and an Organization might rather Ignore such values (an Ignored Observable could skip the lookup altogether).
