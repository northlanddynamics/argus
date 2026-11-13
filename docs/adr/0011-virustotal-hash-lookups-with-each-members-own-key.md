# VirusTotal looks hashes up with each Member's own API key, cached for the Organization

Hovering an MD5, SHA-1 or SHA-256 anywhere in Argus shows what VirusTotal knows about the file (`docs/wireframes/hash-context-popup.md`), and a hash Observable's page shows the same as a card. Unlike IPinfo (ADR 0010), VirusTotal is not an Integration: each Member sets their own VirusTotal API key in Your settings, and their lookups are made with it. VirusTotal's public keys are personal, free and rate-limited per person (4 lookups a minute, 500 a day), and its terms tie a key to its holder, so one shared key would both break the terms and run out at once.

- **The key is the Member's alone.** Set, replaced and removed only by them (`PUT`/`DELETE /api/virustotal-key`), sealed at rest like Integration credentials, and never shown again but for its last four characters, to anyone, Admins included. It is checked when set by looking up the EICAR test file: a refused key is not saved. It goes when its Member leaves the Organization. Setting and removing it are not in the Organization Audit Log: it is the Member's own setting, not the Organization's.
- **Made while the Member waits**, by the `web` process, with an 8-second timeout, as ADR 0010 decided for IPs. Concurrent lookups of one hash with one key share one call.
- **Cached for the Organization** in `hash_lookups`, one row per Organization and hash. What VirusTotal reports is a fact about a file, not about the key that asked, so any Member, with a key or without, reads what any other's key fetched, and the Organization spends one lookup per file however many Members hover it. A report found by one hash is stored under the file's MD5, SHA-1 and SHA-256. Reports are served for a day before VirusTotal is asked again, since engines' verdicts change; "never seen" for an hour, since a file may be submitted at any moment. Refresh always asks. A Member without a key sees what is cached, however old, and is pointed to Your settings to refresh it.
- **Failures belong to the key.** Refused, quota used up or unreachable is recorded on the Member's key, not the cache, and that key isn't tried again for a minute unless its Member refreshes. Another Member's lookups are unaffected, and their key is never borrowed.
- **Members only.** Guests get no popup and no lookup.
- **Only hashes are sent**, never files. An Evidence file's SHA-256 can be hovered too; looking it up tells VirusTotal only the fingerprint.

## Considered Options

- **An Organization-wide VirusTotal Integration, as for IPinfo**: rejected. A free key is personal and allows a few lookups a minute; a premium key is usually one analyst's. Members asked to bring their own.
- **A cache per Member**: rejected. It would spend every Member's small quota on the same files, and the answer doesn't depend on who asked.
- **Using any Member's key when the hoverer has none**: rejected. It spends someone's personal quota without them, and breaks VirusTotal's terms.
- **Fetching through the worker, or on arrival**: rejected for the reasons ADR 0010 gives.

## Consequences

- Argus now holds a credential per Member, not just per Organization.
- What a Member without a key sees may be older than a day; the popup says how old.
- Lookups are not Audit Logged: they read, and change nothing in Argus or VirusTotal.
- The v3 file API calls are unverified against a live key.

_Update: hover no longer opens anything. The same details now open in the Enrichment panel, docked on the right (`docs/wireframes/enrichment-panel.md`); what is looked up, cached and shown is unchanged._

_Update: resting the pointer on a hash opens the hover card again, beside the Enrichment panel; focus does not open it. Opening it makes the same cached lookup the panel does, so it spends a Member's key only when nothing fresh is cached._
