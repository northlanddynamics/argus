# Account context popup: wireframes

> The account counterpart of the IP context popup (`ip-context-popup.md`): what an Analyst sees on resting the pointer on an account Asset. The account's own page shows everything Falcon reports (the "Falcon identity" card); this popup shows only what answers "who is this and should I worry": full name, account state, privilege and last activity.

Shown wherever an account Asset is a link: the Alert queue's account column, a Case's Assets, the Assets an Alert shares with a Case (Correlations), the Action Center log and the Ignored list. The details are the Falcon Identity Protection Enrichment recorded on the account (ADR 0009), the same data the account's page reads, so they stay live through the same signals.

## Behaviour

- Same timing and placement as the IP popup: opens 400 ms after the pointer rests on the account, closes 150 ms after it leaves both, or on Esc; 320 px wide, below the account and flipped above when there is no room. It doesn't open from keyboard focus, nor over an open right-click menu.
- The account keeps doing what it did: the link still opens its page.
- Fetched when the popup opens, not when the account renders. Opening it asks Falcon again for anything older than 15 minutes, as opening the account's page does.
- Guests get no popup: they never see Enrichment.

## A. Identity found

```
┌──────────────────────────────────────────────┐
│ CORP\jsmith                            [⧉]  │  ← the account as Argus holds it; Copy
├──────────────────────────────────────────────┤
│ Jane Smith                                   │  ← Falcon's display name
│ jsmith@corp.example                          │  ← UPN (or email), mono, muted
│ State         Enabled [Stale]                │  ← Enabled/Disabled, then Locked out and Stale
│                                              │    when true; anything worth attention in the
│                                              │    notice tone
│ Privileged    [Privileged]                   │  ← or "No"; "Unknown" when Falcon didn't say
│               Domain Admins, Server Operators│  ← privileged groups, muted
│ Last activity 2 hours ago                    │  ← relative, full time on hover
├──────────────────────────────────────────────┤
│ Falcon · as of 4 min ago           [Refresh] │
└──────────────────────────────────────────────┘
```

An ambiguous account (several identities by the same name for one Integration) shows one identity at a time, marked **Ambiguous**, stepped through with `‹` `›` between the header and the details, as the IP popup steps through its pages:

```
├──────────────────────────────────────────────┤
│ [‹]          Identity 2 of 3           [›]  │  ← ‹ disabled on the first, › on the last
├──────────────────────────────────────────────┤
```

With more than one CrowdStrike Integration, each Integration's identities (or its lookup state, when it has none) are pages too, and the pager names the Integration shown ("CrowdStrike EU · 2 of 3"). The footer's "as of" and Refresh cover every page.

## B. Looking up

Skeleton rows in the shape of A, and "Falcon · refreshing…" in the footer.

## C. Not found / not fetched / failed

- "Not found in Falcon." when Falcon knows no identity by the account's name, or no longer knows the recorded one.
- Falcon's reason in the notice tone when the last fetch failed, above any details Argus still has.
- The Integration's health reason when its API client can't read Identity Protection.

## D. No CrowdStrike Integration

```
┌──────────────────────────────────────────────┐
│ CORP\jsmith                            [⧉]  │
├──────────────────────────────────────────────┤
│ No CrowdStrike Integration to look this      │
│ account up in. An Admin can add one in       │
│ Settings · Integrations.                     │
└──────────────────────────────────────────────┘
```
