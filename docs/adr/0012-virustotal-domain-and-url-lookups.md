# VirusTotal looks domains, email addresses and URLs up too, never submitting anything and never sending internal names

Hovering a domain, an email address or a URL anywhere in Argus shows what VirusTotal knows about it (`docs/wireframes/domain-url-context-popup.md`), and its Observable's page shows the same as a card. Until now only IPs (ADR 0010) and hashes (ADR 0011) had lookups, yet phishing, the most common Case Type for an in-house team, is mostly decided on domains and URLs: how many engines flag them, what vendors categorise them as, and above all how recently the domain was registered.

Everything ADR 0011 decided for hashes holds: each Member's own key, lookups made while they wait, an Organization-wide cache any Member reads (`virustotal_lookups`, one row per Organization, kind and value), reports served for a day and "never seen" for an hour, failures recorded on the key and the key rested for a minute, Members only. One key's rest covers all three kinds: its quota is one.

- **Domains** come from `GET /domains/{domain}`: the engines' verdict, vendor categories, registration date and registrar (from WHOIS), its DNS records, the HTTPS certificate it last served, popularity ranks, tags and community votes. A domain registered less than 30 days before the lookup is answered as `newlyRegistered`, and the popup leads with it.
- **Email addresses** are looked up by their domain alone. The mailbox name never leaves Argus: it may be a colleague's, and it says nothing VirusTotal can rate. An address and its domain share one cached answer.
- **URLs** come from `GET /urls/{id}`, the id being the URL in unpadded base64url, so VirusTotal canonicalises it as it does its own submissions. Argus only looks URLs up and **never submits one for scanning**: a submission makes VirusTotal visit the URL, which can spend a one-time link, tip off whoever is watching it, or publish a link the Organization was sent. A URL VirusTotal hasn't seen says so; a Member who wants it scanned does that on virustotal.com themselves.
- **Never sent:** names only meaningful inside a network (`.local`, `.internal`, `.corp`, `.lan`, `.home.arpa` and other special-use or private top-level names), URLs on reserved addresses (as ADR 0010 defines them), and URLs carrying a username or password. These are answered as `withheld`, with the reason, and cost no call. They say nothing to VirusTotal and would describe the Organization, or hand over a credential.

## Considered Options

- **RDAP for registration data, with no key**: deferred. It would give Members without a VirusTotal key a domain's age, but VirusTotal already reports it, and RDAP needs a bootstrap lookup and a call to whichever registry serves each top-level name, each a host to allow and a format to verify. Worth adding if Members without keys ask for it.
- **Passive DNS (`/domains/{domain}/resolutions`)**: rejected for now. It costs a second call of a four-a-minute quota per hover; the domain report's current records answer most questions.
- **Submitting unseen URLs for scanning**: rejected, for the reasons above.
- **Looking up the full email address**: rejected. VirusTotal has no email object, and it would send the mailbox name.
- **Looking a URL's domain up alongside the URL**: rejected. It doubles the quota spent per hover; the domain is usually on the Case as its own Observable.

## Consequences

- Every Observable type now has a context popup and, for Members, a card on its page.
- Domains and email addresses gain "Open in VirusTotal" in the Observable menu; a URL's VirusTotal page is linked from its popup once VirusTotal has reported on it, since its page is under an identifier only VirusTotal computes.
- A URL is sent whole, query string included. Analysts should not add URLs carrying tokens as Observables when they don't want them looked up; Argus withholds only those whose credentials are in the userinfo.
- The v3 domain and URL APIs are unverified against a live key.
