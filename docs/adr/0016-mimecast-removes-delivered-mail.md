# Mimecast removes delivered mail from a sender, and the Take action menu blocks and removes in one place

_Proposed._

Phishing Cases need two things from Mimecast: stop the sender's next message, and take back what already arrived. ADR 0007 gave the first, a Blocked Senders entry for an email address or its domain, applied to everyone in the Organization. ADR 0008 put it one click away. This ADR adds the second, as a new Response Action kind, and fixes how both appear under "Take action".

## Take action, for an email address Observable

Under each Mimecast Integration that takes Response Actions:

- **Block sender**: unchanged. An Organization-wide Blocked Senders entry for the address. One click.
- **Block domain**: unchanged. The same for every address at its domain, hinted "Everyone at `<domain>`". One click.
- **Remove delivered mail…**: new. Takes every message from the address out of every mailbox Mimecast delivered it to within the Integration's lookback. Confirmed, never one click (see below).
- **Block and remove…**: new. Block sender and Remove delivered mail as two Response Actions from one confirmation, since a phishing response almost always wants both and removal alone lets the next message through.
- **Restore mail…**: on a removal this Case created, puts the messages back. Confirmed, and names other Cases relying on it.
- **Retry** and **Dismiss record…** as for every other kind.

A domain Observable gets only **Block domain**. Ticking several email Observables offers Block sender, Block domain and Remove delivered mail per Integration, leaving out what the Case already holds there, as ADR 0008 does.

The block items already exist; this ADR changes nothing about them except their place beside removal.

## Decisions

- **A new kind, `mimecast_remediation`, action "Remove delivered mail".** Target type `email`, target value the address in lowercase. Its external id is Mimecast's remediation incident code. It goes through the outbox with retry and backoff, as ADR 0007 has every Response Action.
- **Address only, not domain.** Removing everything from `gmail.com` or a supplier's domain would empty mailboxes of real mail. Domain removal is deferred until there is a way to show the count before it runs.
- **A per-Integration Mail removal setting, separate from Response Actions**, off until an Admin turns it on, as Host containment is (ADR 0009). It needs the Mimecast API application's Threat Remediation: Edit permission, which blocking does not. The health check probes it when the setting is on and records a missing permission without affecting blocking, as host Enrichment errors are recorded.
- **A lookback per Integration, set by an Admin** on Settings · Integrations, as Falcon severity and platforms are (ADR 0008): 1 to 90 days, default 30. The window is from that many days before the Response Action is taken up to the moment it is taken, and it is recorded on the Response Action, so changing the default leaves queued and sent ones as they were. Mail that arrives later is not removed, which is why Block and remove exists.
- **Confirmed, not one click.** Removal reaches into every mailbox in the Organization. The confirmation names the address, the window, the Integration, and that it applies to every mailbox. It does not show how many messages match: Mimecast reports that only once the incident runs.
- **Who may take it**: any Member who can work the Case, as for containment. Guests never. Restoring is the same, and on a Closed Case only an Admin, without reopening, as ADR 0007 has removal.
- **The reason sent to Mimecast** is `C-<n>: <title> <link>`, cut to Mimecast's limit, as Umbrella's comment is (ADR 0014).
- **What Mimecast is asked.** The adapter gains `removeFrom(address, start, end, reason) → incident code`, `incident(code) → counts`, and `restore(code, reason)`. If Mimecast's create-incident call can search by sender alone, `removeFrom` makes one incident with `from` set and the window. If it requires a message id, hash or URL, `removeFrom` first finds the message ids from the address in the window through Message Finder, then makes one incident per message id, and the external id becomes the list of codes. Which one applies is settled by trying it against a live account before building; the Response Action and the menu are the same either way.
- **Progress comes back by polling.** An incident runs asynchronously. The worker reads it every minute until its counts stop changing and records them on the Response Action: identified, removed, failed and, after a restore, restored. The UI shows "Removed 14 of 15 messages, 1 failed" rather than a bare Active. Zero identified is a success, shown as "No messages found".
- **States** map onto ADR 0007's: Pending (queued, or created and still running), Active (finished), Failed (Mimecast refused the incident, or every attempt to create it failed), Removing (restore requested), Removed (restored). Some messages failing is Active with the failures shown, not Failed; Retry on it makes a new incident for the same window, which skips what is already removed.
- **Already present.** While a removal of the same address through the same Integration is Pending, a second one from any Case is recorded already present and points at it. Once that one is Active, a new one runs again: unlike a block, mail may have arrived since. Removals Argus did not make are not looked for; Mimecast has no cheap way to ask, and running one twice is harmless.
- **Restore is once.** Mimecast restores an incident only once and only while the messages are still in the archive. So Restore mail goes Removing → Removed or Failed, and a Failed restore can be retried only if Mimecast reports the incident was not restored.
- **Ignored Observables** still ask for confirmation, as for every Response Action. In addition, Block domain and removal refuse an address at a domain an Admin has marked Ignored, such as the Organization's own mail domain, unless an Admin takes it.

## Considered Options

- **One click, as blocking is**: rejected. A block stops future mail and is undone by one delete. A removal changes what is in every recipient's mailbox now.
- **Domain removal**: deferred, as above.
- **A window chosen per click**: rejected for the one-click path, as ADR 0008 rejected per-click severity. "More options…" may later allow a custom window.
- **Admin approval before removal**: deferred with ADR 0007's approval option. The Mail removal setting and the confirmation are the guard for now.
- **Removing through Microsoft Graph or Google directly**: rejected. Mimecast already holds the delivery log and the archive copy that makes restore possible, and it is the Integration the Organization gave Argus.

## Consequences

- This bends ADR 0007's "Argus never deletes in a tool what it did not put there": removal moves messages Argus did not put there. It is allowed because the messages stay in Mimecast's archive and Restore puts them back, and because the Organization turned Mail removal on.
- Mimecast's Remediation 2.0 (May 2026) changes how Microsoft 365 removal works underneath. The adapter hides it, but the live check above must be made against an account on Remediation 2.0.
- A Pending or Removing removal holds the Integration as ADR 0013 describes: it cannot be deleted while one runs. An Active removal does not hold it, since the messages are already out of the mailboxes; deleting the Integration takes Restore away, and the delete confirmation says how many removals that affects.
- Removals appear on the Case's Timeline and in the Audit Log with their counts, and Guests see them unless they are Internal.
- The Mimecast API calls are unverified against a live account, as for blocking.
