# Hash context popup: wireframes

> These details show in two places: this hover card, on resting the pointer on a hash, and the Enrichment panel (`enrichment-panel.md`), opened on purpose. The content and wording of each state below apply to both. The hover card opens on pointer hover only, after 400 ms, as the IP card does; from the keyboard, `I` opens the panel instead. While it looks up and once it has a report, its body keeps one height and scrolls, so it never grows and flips away from the pointer.

What a Member sees on hovering (or focusing) an MD5, SHA-1 or SHA-256 in Argus: the hash Observables on a Case and their pages, an Alert's extracted indicators, Bulk Lookup, Response Actions and an Evidence file's SHA-256. The report comes from VirusTotal, looked up with the Member's own API key (ADR 0011), and is cached for the Organization. It follows the IP context popup (`ip-context-popup.md`) in everything but its content.

## Behaviour

- Opens, closes, places itself and starts its lookup as the IP context popup does. When there isn't room for all of it, it scrolls.
- The header shows the whole hash, lowercase and wrapped; Copy copies it, and ↗ opens the file on virustotal.com.
- Guests get no popup.

## A. Found

```
┌──────────────────────────────────────────────┐
│ a3f5c8e1d2b4a6f8e0c2d4b6a8f0e2c4d   [⧉] [↗] │  ← mono, wraps; Copy; open on virustotal.com
│ 6b8a0f2e4c6d8b0a2f4e6c8d0b2a4f6              │
│ Invoice_0423.pdf.exe                         │  ← VirusTotal's meaningful name, muted
├──────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────┐ │
│ │ 61/69 engines flag it malicious          │ │  ← destructive tone from 3 engines, notice
│ │ ███████████████████████████████████░░░░  │ │    tone for 1–2 or any suspicious, else plain
│ └──────────────────────────────────────────┘ │
│ [peexe] [signed]                             │  ← VirusTotal tags, at most six
│ Threat      trojan.emotet/generic            │  ← suggested label, mono; top categories muted
│             trojan                           │
│ Detections  BitDefender Trojan.GenericKD.713 │  ← first three engines by name
│             ESET-NOD32 Win32/Emotet.CK       │
│             and 58 more                      │
│ Type        Win32 EXE · 471 KB               │
│ Also named  invoice.exe, scan_0423.exe       │
│ Signed by   Fake Corp Ltd                    │  ← verification on hover
│ First seen  20 years ago                     │
│ Analysed    7 days ago                       │
│ Community   40 malicious · 1 harmless        │
├──────────────────────────────────────────────┤
│ VirusTotal · as of 3 h ago         [Refresh] │
└──────────────────────────────────────────────┘
```

Rows VirusTotal says nothing for are left out.

## B. Looking up

Skeleton rows in the shape of A, footer "VirusTotal · looking up…".

## C. Never seen

```
│ VirusTotal has never seen this file.         │
├──────────────────────────────────────────────┤
│ VirusTotal · as of 5 min ago       [Refresh] │
```

## D. No key, nothing cached

```
│ No VirusTotal report yet. Each Member looks  │
│ hashes up with their own VirusTotal API key. │
│ [Add your key in Your settings]              │  ← no footer
```

A Member without a key still sees what others' keys fetched, however old, as A, with "Add your key to refresh" in place of Refresh.

## E. Failed

```
│ ⚠ VirusTotal refused your API key · Your key │  ← notice tone; the reason, and a link to Your settings
│ (A, as last cached, if anything was)         │
├──────────────────────────────────────────────┤
│ VirusTotal · as of 2 d ago           [Retry] │
```

## F. On a hash Observable's own page

A as a "VirusTotal" card above its Cases, the name among the rows, Refresh in the footer.
