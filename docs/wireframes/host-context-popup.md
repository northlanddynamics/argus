# Host context popup: wireframes

> The host counterpart of the account context popup (`account-context-popup.md`): what an Analyst sees on resting the pointer on a host Asset. The host's own page shows everything Falcon reports (the "Falcon devices" card); this popup shows only what answers "what is this machine and is it contained": containment, platform, last seen, last user and addresses.

Shown wherever a host Asset is a link: the Alert queue's host column, an Alert's Host and Extracted Assets, a Case's Assets and contained hosts, the Assets an Alert shares with a Case (Correlations), Response Actions, the Action Center log, the Observables page, search results, an Observable's Alerts, and the hosts that last reported an internal IP in the Enrichment panel. All of them go through `ItemContext` (`apps/web/src/components/item-context.tsx`), which also gives Observables their Enrichment and right-click menu and accounts their card.

## Behaviour

- Same timing and placement as the account popup: opens 400 ms after the pointer rests on the host, closes 150 ms after it leaves both, or on Esc; 320 px wide, below the host and flipped above when there is no room. It doesn't open from keyboard focus, nor over an open right-click menu.
- The host keeps doing what it did: the link still opens its page.
- Fetched when the popup opens, not when the host renders. Opening it asks Falcon again for anything older than 15 minutes, as opening the host's page does.
- Not inside another hover card: a host listed in an internal IP's card is a plain link.
- Guests get no popup: they never see Enrichment.

## A. Device found

```
┌──────────────────────────────────────────────┐
│ FIN-LT-0231                            [⧉]  │  ← the host as Argus holds it; Copy
├──────────────────────────────────────────────┤
│ 8f1c2b3a4d5e6f708192a3b4c5d6e7f8 ↗           │  ← Falcon device ID, opens the console
│ Containment  [Contained]                     │  ← "Not contained", or the state in the
│                                              │    destructive tone
│ Platform     Windows 11                      │
│ Last seen    2 hours ago                     │  ← relative, full time on hover
│ User         ACME\d.howe                     │  ← last logged-on user, mono
│ Local IP     10.20.4.31                      │
│ External IP  203.0.113.24                    │
├──────────────────────────────────────────────┤
│ Falcon · as of 4 min ago           [Refresh] │
└──────────────────────────────────────────────┘
```

An ambiguous host (several devices by the same hostname for one Integration) shows one device at a time, marked **Ambiguous**, stepped through with `‹` `›` ("Device 2 of 3"), as the account popup steps through identities. With more than one CrowdStrike Integration, each Integration's devices (or its lookup state, when it has none) are pages too, and the pager names the Integration shown.

## B. Looking up

Skeleton rows in the shape of A, and "Falcon · refreshing…" in the footer.

## C. Not found / not fetched / failed

- "Not found in Falcon." when Falcon knows no device by the hostname, or no longer knows the recorded one.
- Falcon's reason in the notice tone when the last fetch failed.
- The Integration's health reason when its API client can't read hosts.

## D. No CrowdStrike Integration

"No CrowdStrike Integration to look this host up in. An Admin can add one in Settings · Integrations."
