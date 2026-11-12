# Private IPs are looked up in Falcon, by the host that last reported them, while the Member waits

_Proposed._

ADR 0010 answers private and other internal addresses without a call: IPinfo knows nothing about them, and sending them would describe the Organization's network to a third party. But an internal address is the one an Analyst most needs explained ("which of our machines is 10.20.4.17?"), and the Organization's own CrowdStrike tenant already knows: every sensor reports its host's local IP. So an internal address is now looked up in Falcon, through each of the Organization's CrowdStrike Integrations, and shown in the same hover card and Enrichment panel (`docs/wireframes/ip-falcon-lookup.md`).

**Which addresses.** Private (10/8, 172.16/12, 192.168/16), shared (100.64/10, which many networks use internally) and IPv6 unique local (fc00::/7), and the IPv4-mapped forms of them. These are the internal ranges in `reservedRange`; they gain a flag saying so. Loopback, link-local, multicast, documentation, benchmarking, unspecified and the other reserved ranges are still answered without any call: every host has them, or none does. Public addresses still go to IPinfo only.

**What is asked.** Falcon's Hosts API, the same Hosts: Read scope that host Enrichment needs (ADR 0009), and so no Admin setting:

1. `GET /devices/queries/devices/v1?filter=local_ip:'<ip>'`, sorted by `last_seen` descending, at most 50 `aid`s, with Falcon's total.
2. `hosts(aids)`, the call host Enrichment already makes, for each device's details.

`FalconClient` gains `findHostsByLocalIp(ip)` beside `findHosts(hostname)`.

**"Last reported", never "is".** `local_ip` is the address a sensor reported most recently. Addresses are leased and re-leased, so the host holding one now may not be the one that held it when an Alert fired, and a host that has gone quiet may have handed it on. Argus says which hosts last reported the address and when each was last seen, and never names one as the address's owner. Several hosts are common (VPN pools, NAT, Docker's 172.17.0.1, home routers' 192.168.1.x on remote laptops) and are all listed, newest first.

**Made while the Member waits**, as IPinfo lookups are (ADR 0010) and unlike host Enrichment, which the worker fetches: a hover cannot wait for the worker's tick.

- The `web` process gains `Deps.falcon`. It keeps one client per Integration and credentials revision, so the OAuth token is reused across hovers and not minted per call. 8-second timeout. Concurrent lookups of one address in one process share one call.
- Every CrowdStrike Integration that isn't deleted or paused is asked, in parallel. Each answers separately.

**Cached in `falcon_ip_lookups`**, one row per Integration and address: the `aid`s matched, Falcon's total, when it was fetched and checked, and the last error. Served for 15 minutes (`HOST_ENRICHMENT_MAX_AGE_MS`), not IPinfo's 7 days, because leases move. Refresh always asks. A failed lookup keeps the last answer, says why, and is not retried for a minute unless someone refreshes.

**Host details are host Enrichment's.** The devices fetched are written to `falcon_host_snapshots` through the same function the worker uses, so a host's page and an IP's lookup show one snapshot, and a fetch that shows a host released still ends Argus's containment of it (ADR 0009). That function moves out of the worker loop so both processes call it.

**Linking to Assets.** A matched device whose `aid` is recorded on a host Asset links to that Asset's page. Others are shown by hostname and link to the Falcon console, as host Enrichment does. Nothing is created or linked to a Case by looking.

**Health.** Only a missing scope is recorded on the Integration (`host_enrichment_error`, as host Enrichment does). Other failures show in the card and change nothing: the stream worker owns a CrowdStrike Integration's health, and a slow hover shouldn't mark it Reconnecting.

**Members only**, as before. Guests get no hover card or panel. A host Asset already linked to a Guest's Case still shows them its own Enrichment.

## Considered Options

- **Looking up through the worker, like host Enrichment**: rejected, for the reason ADR 0010 gives.
- **Matching only against snapshots Argus already holds**: rejected as the answer, kept as a hint. Argus holds snapshots only for hosts linked to Cases, so most addresses would show nothing. A snapshot that already shows the address is used to draw the card before Falcon answers.
- **Looking up every internal IP as it arrives on an Alert or Case**: rejected, as ADR 0009 and 0010 rejected it: it spends calls on addresses nobody looks at, and the answer goes stale in 15 minutes anyway.
- **Who held the address at a given time**: deferred. The Hosts API can't be asked that by address. Falcon's network address history (`/devices/combined/devices/network-address-history/v1`) is asked by `aid`, so it could say when each matched host took the address and from when the previous holder had it. Event search could answer it outright but needs Falcon Insight data retention and a different API. Worth its own ADR if Analysts often need it.
- **Unmanaged devices from Falcon Discover / Exposure Management**: deferred. They would cover printers, phones and servers without a sensor, but need the Assets: Read scope and a separate subscription. Shown as "not found" for now.
- **Looking public addresses up by `external_ip`** ("which of our hosts egress from this address"): deferred. It is the same call with a different field, and would put a CrowdStrike section under IPinfo's for public IPs.
- **Containing a matched host from the card**: rejected. Containment stays on a host Asset linked to a Case, with its own confirmation (ADR 0009). "Add host to this Case" from the panel is the way there; it is designed in the wireframe but not built in the first cut.

## Consequences

- Contradicts ADR 0010's "never sends reserved addresses" only in part. Internal addresses still never go to IPinfo. They now go to the Organization's own CrowdStrike tenant, which already holds them. ADR 0010 gets an update note saying so.
- The `web` process now calls Falcon while serving a request, as it already calls IPinfo, VirusTotal and Umbrella. A slow Falcon makes the card slow, nothing else.
- `falcon_host_snapshots` gains a second writer. Containment's "lifted in Falcon" can now be noticed by a hover as well as by the worker. It is recorded and attributed the same way.
- A host's IPs in its host Enrichment, which already open the IP hover card, now show the other hosts that last reported the same address.
- IP lookups are not Audit Logged, as before. A lookup from the Action Center is still recorded in the Action Log.
