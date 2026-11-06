# CrowdStrike enriches hosts and identities, and contains hosts

A CrowdStrike Integration now reads Falcon's view of the Organization's Assets and can contain hosts.

**Identity.** A host Asset keeps its hostname as its match key. It also records the Falcon device ID (`aid`) per Integration, taken from detections at ingest. Argus uses the `aid` whenever it has one when talking to Falcon. A host with no `aid` is looked up by hostname:

- One match records that device.
- Several matches are all recorded and the Asset is marked ambiguous.
- No match shows "Not found in Falcon" and is tried again on the next refresh.

Account Assets resolve the same way to Falcon Identity Protection identities:

- by UPN or email when the value has an `@`;
- by domain and SAM name for `DOMAIN\user`;
- by SAM name alone for a bare name, which may be ambiguous.

The identity's entity ID is then used in place of the name. A host links to its device in the Falcon console, except for Guests.

**Enrichment.** Argus keeps only the latest snapshot Falcon reports, shown as of when it was fetched.

- Opening an Asset, or a Case it is linked to, refetches anything older than 15 minutes, and Refresh always refetches.
- Hosts show OS and platform, sensor version and status, first and last seen, IPs and MAC, domain, OU and site, hardware, last logged-on user, host groups, Falcon tags and containment status.
- Identities show risk score, severity and risk factors; enabled, locked, stale, privileged (with the groups) and watched; password age; last activity; directory attributes; and associated endpoints. The endpoints are listed by name and never linked to the Case.
- Enrichment is read-only. So it is on whenever the API client has Hosts: Read or Identity Protection Entities: Read, without the Admin consent that write-back and Response Actions need. A missing scope or licence shows in Integration health and affects nothing else.
- Guests see enrichment on Assets linked to their Case, and marking that link Internal hides it.

**Correlation.** An Alert also correlates with a Case when its `aid` or identity entity ID is recorded on an Asset linked to that Case, even after a rename. Assets are never merged.

**Containment** is a Response Action against one host, extending ADR 0007 beyond Observables.

- It has its own per-Integration setting, off until an Admin turns it on, and needs Hosts: Write.
- Any Member who can work the Case may contain a host. It is never one click: the confirmation refetches the host and shows its name, `aid`, platform, host groups and last-seen time.
- It targets exactly one `aid`. On an ambiguous host the Analyst picks the device, and a host with no `aid` cannot be contained.
- A host already contained is recorded as already present, and nothing is sent.
- Lifting containment that Argus imposed works like removing an IOC: any Member who can work the Case may do it, after a confirmation that names the other Cases relying on it.

Unlike an IOC, containment's real state comes back in enrichment. If Falcon shows the host released outside Argus, the Response Action moves to Removed, noted "lifted in Falcon" and attributed to CrowdStrike in the Audit Log.

**Lifting containment Argus did not impose** is allowed, as its own "Lift containment" Response Action taken from a Case the host is linked to. Only Admins may take it, after a warning that Argus did not contain the host. Any Argus containment records for that device on other Cases then move to Removed, noting the Case that lifted it.

## Considered Options

- **Re-keying hosts by `aid`**: rejected. Hand-added hosts and detections without an `aid` have nothing else to key on, and existing hosts would split.
- **Scheduled enrichment of every known host**: rejected. It spends API quota on hosts nobody is looking at.
- **Keeping enrichment history**: rejected. It duplicates Falcon, and what mattered at detection time is already on the Alert.
- **One-click containment**: rejected. Containment can take down a production server, and the confirmation is what shows a domain controller for what it is.
- **A protected-host list**: deferred. The confirmation shows host groups. A never-contain list by host group can come later.
- **Identity response actions** (disable account, force password reset): deferred. They go through Identity Protection policy or the identity provider and need their own design.

## Consequences

- ADR 0007's rule that Argus never undoes in a tool what it did not put there now has one exception: lifting containment. It is containment only, because containment is a temporary state that a Case owns, while IOCs and blocks are standing policy someone chose. IOCs and Mimecast blocks keep the rule.
- ADR 0007 says "Active" means only "sent". For containment it now also means Falcon last reported the host contained.
- Identity enrichment needs a Falcon Identity Protection subscription. Without it, account Assets are simply not enriched.
