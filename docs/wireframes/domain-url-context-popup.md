# Domain, email and URL context popups: wireframes

> Where these details appear has moved to the Enrichment panel (`enrichment-panel.md`): hover no longer opens a popup. The content and wording of each state below still apply, as a section of the panel.

What a Member sees on hovering (or focusing) a domain, an email address or a URL in Argus: on a Case's Observables and their pages, an Alert's extracted indicators, Bulk Lookup and Response Actions. The report comes from VirusTotal, looked up with the Member's own API key and cached for the Organization (ADR 0012). It follows the hash context popup (`hash-context-popup.md`) in everything but its content; its "no key", "never seen" and "failed" states are the hash popup's C, D and E.

## Behaviour

- Opens, closes, places itself and starts its lookup as the IP and hash popups do.
- The header shows the value defanged, wrapped; Copy copies it defanged (the Observable menu offers both). ↗ opens the domain on virustotal.com, or the URL once VirusTotal has reported on it.
- Guests get no popup.

## A. Domain

```
┌──────────────────────────────────────────────┐
│ invoice-portal[.]biz                 [⧉] [↗] │
├──────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────┐ │
│ │ 7/93 engines flag it malicious · 1 susp. │ │  ← tone as for files
│ │ ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ │
│ └──────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────┐ │
│ │ ⚠ Newly registered: 6 days ago           │ │  ← notice tone; under 30 days only
│ └──────────────────────────────────────────┘ │
│ [dga]                                        │
│ Categories  phishing, business               │  ← most vendors agreeing first
│ Detections  BitDefender phishing             │
│             and 6 more                       │
│ Registered  6 days ago                       │
│             NameCheap, Inc.                  │
│ Resolves to 185.220.101.4                    │  ← A, AAAA, CNAME; mono
│ Mail        mail.invoice-portal.biz          │  ← MX
│ Nameservers dns1.registrar-servers.com       │
│ Certificate Let's Encrypt                    │
│             issued 5 days ago                │
│ Popularity  #40,210 in Cisco Umbrella        │  ← best rank
│ Analysed    2 days ago                       │
│ Community   4 malicious · reputation -21     │
├──────────────────────────────────────────────┤
│ VirusTotal · as of 3 h ago         [Refresh] │
└──────────────────────────────────────────────┘
```

## B. Email address

A, for its domain, with "Its domain, invoice-portal[.]biz" muted under the address in the header. On its page, the card is titled "VirusTotal · invoice-portal[.]biz".

## C. URL

```
│ hxxps://invoice-portal[.]biz/login?…  [⧉] [↗] │
├──────────────────────────────────────────────┤
│ 9/89 engines flag it malicious               │
│ Title       Sign in to your account          │
│ Ends at     hxxps://invoice-portal[.]biz/m365│  ← after redirects, when elsewhere
│ Redirects   1 before it ends                 │
│ Response    HTTP 200                         │
│ Categories  phishing                         │
│ Detections  Sophos phishing · and 8 more     │
│ Threats     Mal/HTMLGen-A                    │
│ First seen  10 days ago                      │
│ Analysed    8 days ago                       │
```

Never seen: "VirusTotal has never seen this URL. Argus doesn't submit URLs for scanning."

## D. Withheld

```
│ fileserver[.]corp                       [⧉]  │  ← no ↗
├──────────────────────────────────────────────┤
│ .corp names are only meaningful inside a     │
│ network, so they aren't sent to VirusTotal   │  ← muted; no footer
```

## E. On its own page

A or C as a "VirusTotal" card above its Cases, Refresh in the footer.
