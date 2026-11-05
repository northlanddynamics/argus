# Integrations have Providers, and Response Actions go out through an outbox and never overwrite

An Integration now has a Provider (CrowdStrike, Mimecast) that fixes what it can do: receive Alerts, write changes to Alerts back (ADR 0002), and take Response Actions. Every Provider uses the one `integrations` table with Provider-specific sealed credentials. Mimecast is the first Provider that sends no Alerts. It only takes Response Actions.

A Response Action is always taken from a Case, against one Observable linked to that Case. This round has two kinds:

- **Falcon custom IOC**: sha256, md5, domain and IP. Falcon accepts no URL, email or SHA-1. The analyst picks Detect or Prevent, and Falcon allows Prevent only for hashes. Severity comes from the Case. The IOC applies on every platform, globally, with source `Argus` and the description `C-<n>: <title>` linking back to the Case.
- **Mimecast blocked sender**: an Organization-wide Blocked Senders policy entry for an email address or its domain. When the domain isn't yet linked to the Case, it is linked as an Observable first.

Response Actions are a per-Integration setting, separate from Alert write-back, off until an Admin turns it on. The Falcon API client needs IOC Management write scope, which is not the Alerts write scope. Any Member who can work the Case may take or remove a Response Action. Guests never can. On a Closed Case, an Admin may remove one without reopening it. An Analyst needs the Case reopened first.

Sending and removing are queued in an outbox in the same transaction as the change, as write-back is, so they survive restarts and retry with backoff. A Response Action moves Pending → Active → Removing → Removed, or to Failed with the error and a Retry. When removal is retried and the tool says the IOC or block is already gone, the removal counts as succeeded. There is no expiry and no automatic cleanup.

Argus never overwrites or deletes in a tool what it did not put there. Suppose an Observable was already sent to that Integration from another Case, or the IOC or block already exists in the tool. Argus then records the Response Action as already present and sends nothing. Only the Response Action that created the IOC or block can delete it. An already-present record can only be dismissed from its Case. Removing one that other Cases rely on asks for confirmation, names those Cases where the person can see them, and then marks their records Removed too.

## Considered Options

- **A separate store for action-only tools**: rejected. Credentials, health, Admin consent and the Org Audit Log are the same for every Provider.
- **Admin approval before every Response Action**: deferred. Blocking is time-critical, every action is audited, and every one Argus created can be removed. Approval can come later as a per-Integration option.
- **Expiry and automatic cleanup**: rejected for now. Removal is always a deliberate act from the Case.
- **Overwriting an IOC or block that already exists**: rejected. It would silently change someone else's decision in the customer's tool.

## Consequences

- This extends ADR 0002. A CrowdStrike Integration now also writes IOCs to Falcon when Response Actions are on, which is a different scope and a different consent from Alert write-back.
- "Active" means Argus sent it and hasn't removed it. Someone may have removed it in the tool since, so the UI says when it was sent, never that it is in force.
- A Failed Response Action notifies the Member who took it.
- Response Actions appear on the Case's Timeline and in the Audit Log. Guests see them unless they're marked Internal, but never see Integration settings or errors.
