# Deleting an Integration turns it off for good and keeps it

Admins can delete an Integration they no longer use, such as a Falcon tenant that was retired or an IPinfo token replaced by another account's. ADR 0003 forbids hard deletes, and migration 0017 makes `DELETE FROM integrations` fail: every Alert, Response Action, write-back, Falcon device, Enrichment snapshot and IP lookup made through an Integration points at it, and those records must still say where they came from. So deleting an Integration only marks it deleted (`deleted_at`, `deleted_by_id`), like a deleted Organization.

- **Turned off for good.** Deleting pauses it and turns write-back, Response Actions and Host containment off, so every worker that already skips paused Integrations stops using it, and nothing new is offered through it. A database check keeps a deleted Integration paused. It can't be resumed, rotated or changed; to connect again, an Admin adds a new Integration.
- **Gone from Settings, kept everywhere else.** It is left out of the Integrations list, of host and identity Enrichment and of IP lookups. Alerts, Response Actions and Enrichment already recorded keep showing it by name.
- **Its name and its place are free.** The unique name index, and the one-IPinfo-per-Organization index (ADR 0010), only count Integrations that are not deleted, so a replacement can take the same name.
- **Refused while Argus still holds something in the tool.** While a Response Action taken through it is Pending, Active, Removing, or failed to be removed, deleting is refused (409): once deleted, nothing could remove it from the tool. The Admin removes those from their Cases first. Lifts of containment hold nothing and do not count.
- **Audit Logged** as `integration.deleted` in the Organization Audit Log, with the Provider and credentials hint it had.

## Considered Options

- **Hard delete with cascades**: rejected by ADR 0003. It would also orphan or erase Alerts already attached to Cases.
- **Pausing only, as before**: rejected. A paused Integration stays in Settings forever, holds its name, and an Organization can't replace its IPinfo Integration with another.
- **Deleting and leaving Response Actions in the tool**: rejected. An IOC or containment nobody in Argus can remove would outlive the Case that imposed it.

## Consequences

- The sealed credentials of a deleted Integration stay in the database, never opened, as those of a paused one do.
- Pending write-backs to Falcon through a deleted Integration are never sent, as for a paused one.
