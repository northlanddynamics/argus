# IPinfo looks up IP addresses while the Member waits, cached in Argus, and never sees internal ones

An Admin adds an IPinfo Integration with an API token. IPinfo is a Provider with no Alert stream, write-back or Response Actions (ADR 0007); its one capability is looking up IPs. An Organization has at most one, so there is never a question of which token pays for a lookup. Argus assumes the token's plan includes IPinfo Core (`api.ipinfo.io/lookup/{ip}`): reverse DNS, geolocation, the announcing AS and its type, and the anonymous, hosting, anycast, mobile and satellite flags. Core does not say whether an anonymous address is a VPN, a proxy or Tor, so neither does Argus.

Any IP shown in Argus can be looked up. Hovering or focusing it opens a popup (`docs/wireframes/ip-context-popup.md`), and an IP Observable's page shows the same details as a card.

- **Made while the Member waits.** Unlike Falcon Enrichment (ADR 0009), which a worker fetches after it is marked due, the `web` process calls IPinfo itself, through `Deps.ipinfo`, with an 8-second timeout. A popup cannot wait for the worker's next tick, and one call per address is cheap. Concurrent lookups of one address in one process share one call.
- **Cached in `ip_lookups`**, one row per Integration and address, replaced on every fetch, and served for 7 days before IPinfo is asked again. Refresh always asks. A failed lookup keeps the last details and says why, and is not retried for a minute unless someone refreshes, so a bad token does not cost a call per hover.
- **Never sends reserved addresses.** Private, loopback, link-local, CGNAT, documentation, multicast and other reserved IPv4 and IPv6 ranges (and IPv4-mapped forms of them) are recognised in Argus and answered without a call. They mean nothing outside their own network, and sending them would describe the Organization's network to a third party. An address IPinfo itself calls a bogon is cached and shown the same way.
- **Members only.** Guests get no popup and no lookup: the quota is the Organization's, and the IPs a Guest sees are already on their Case.
- **Health from use.** The worker checks the token once, when the Integration is added, rotated or resumed, and a minute after a check that could not reach IPinfo. It is not checked on a schedule, since every check spends quota. After that, each lookup's outcome sets the Integration's health: refused and quota exhausted are Error, unreachable is Reconnecting.
- A paused Integration serves what is cached and fetches nothing.

## Considered Options

- **Fetching through the worker, like Falcon Enrichment**: rejected. A hover needs an answer in well under a second, and the worker ticks every 5 seconds.
- **Looking up every IP as it arrives on an Alert or Case**: rejected. It spends quota on addresses nobody looks at, as ADR 0009 rejected for hosts.
- **A cache shared across Organizations**: rejected. It would reveal to one Organization which addresses another had looked at, and spend one Organization's quota on another's behalf.
- **Keeping lookup history**: rejected for the reasons ADR 0009 gives. Only the latest answer is kept.

## Consequences

- The `web` process now calls an external service while serving a request. A slow IPinfo makes the popup slow, never anything else.
- IP details are not Audit Logged: a lookup reads, and changes nothing in Argus or in IPinfo.
- Integrations whose credentials are a token, not a client ID and secret, now exist. The hint Admins see is the token's last four characters.

_Update: hover no longer opens anything. The same details now open in the Enrichment panel, docked on the right (`docs/wireframes/enrichment-panel.md`); what is looked up, cached and shown is unchanged._
