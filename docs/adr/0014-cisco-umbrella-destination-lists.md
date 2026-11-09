# Cisco Umbrella adds domains to one destination list, and checks every list for a domain without sending it

An Admin adds a Cisco Umbrella Integration with an Umbrella API key and secret (OAuth 2.0 client credentials at `api.umbrella.com`). Umbrella is a Provider with no Alert stream and no write-back (ADR 0007). It does two things:

- **Response Actions: add a domain to a destination list.** A domain Observable linked to a Case is added to the one destination list an Admin chose for the Integration, as a Response Action of kind `umbrella_destination` (action "Add to destination list"). It goes through the outbox, already-present rules and removal of ADR 0007 unchanged: a domain the list already holds is recorded "already present in the tool" and left alone, and removing it deletes only the destination Argus added. The destination's comment is `C-<n>: <title> <link>`, cut to Umbrella's 255 characters.
- **Checking a domain against every destination list.** Any Member can see, in the Enrichment panel and on a domain or email Observable's page, which of the Organization's destination lists hold the domain or a domain above it (Umbrella applies a domain destination to every name under it), with each list's name, Allow or Block, and the destination's comment.

## Decisions

- **One destination list per Integration, chosen by an Admin.** So that adding one is one click (ADR 0008), the list is a setting on the Integration, picked from the lists Umbrella holds when the Admin opens the chooser, and recorded with its name and access as Umbrella described them. Choosing another is in the Organization Audit Log. Until one is chosen, the Integration isn't offered on Cases. A Response Action records the list it was taken with, as ADR 0008 has severity and platforms recorded, so changing the Integration's list leaves queued and sent ones as they were, and removing one takes it out of the list it went to. Its external id is `<list id>/<destination id>`.
- **Domains only.** Destination lists also take URLs and IPs, but Argus adds only domains. Anything else is skipped with the reason, as Mimecast skips what isn't an email address.
- **The domain is never sent to check it.** Umbrella can't be asked which lists hold a domain, so the `web` process reads every list of the Integration (`/policies/v2/destinationlists` and each list's destinations) and matches in Argus. What it read is kept in that process for five minutes, so a burst of checks costs one read; Refresh always reads again, and concurrent reads for one Integration share one. A failed read keeps what was read before, says why, and isn't retried for a minute unless refreshed. The outcome of each read sets the Integration's health, as IPinfo lookups do (ADR 0010). A paused Integration shows what was last read and reads nothing.
- **Health** is checked by the worker as for Mimecast: signing in when added, rotated or resumed, and every 15 minutes.
- **Members only**, as other lookups. Guests see an Umbrella Response Action on their Case like any other, unless it is Internal.

## Considered Options

- **Choosing the list per Response Action**: rejected for now. It would put a dialog back in front of every add; one Integration per list does the same job, and a second Umbrella Integration can add to another list.
- **Using Umbrella's Investigate API to check a domain**: rejected. It is a separate licence, says what Umbrella's intelligence thinks of the domain rather than what the Organization's own policy does with it, and sends the domain to Cisco.
- **Caching list contents in the database**: rejected. The lists are the Organization's own configuration, change outside Argus, and are cheap enough to re-read; a short in-process cache serves a burst of checks.

## Consequences

- At most one Pending or Active Response Action that Argus created exists per Integration and domain, whichever list it went to. After an Admin changes the Integration's list, adding a domain Argus already added to the old list is recorded "already present", pointing at that one, until it is removed.
- A check reads every destination list on each refresh: an Organization with very large lists pays for it in the time the panel takes, never in anything else.
- The Umbrella API v2 calls are unverified against a live account.
