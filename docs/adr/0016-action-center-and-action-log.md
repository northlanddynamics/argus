# The Action Center runs any action on any value, with or without a Case, and the Action Log records every run

Every action Argus takes on an Observable used to start from where that Observable was shown with its Case: the "Take action" menu (ADR 0008), Contain host (ADR 0009), the Enrichment panel's lookups (ADRs 0010–0012, 0014), and Mark Important and Ignore (ADR 0015). Analysts also act on values before a Case exists, such as a sender reported in a chat channel or a hash in a vendor bulletin, and want one place to see what has been done, by whom and where. The **Action Center** (`/actions`, wireframes in `docs/wireframes/action-center.md`) lists every action, runs any of them on whatever values a Member pastes, and links each run to a Case only if they choose one. Its **Action Log** tab (`/actions/log`) lists every run.

## Decisions

- **Members only.** Guests get no Action Center, as they get no lookups or Response Actions.
- **One catalogue, built from the Organization's Integrations.** There is a card per action per Integration that could take it. Each card says which types it takes and whether it can run now: Response Actions off, no destination list chosen, paused, no IPinfo Integration, or no VirusTotal key. Admin-only actions (Lift containment, Ignore) say so.
- **Any input.** The run dialog takes one value per line or any pasted text, and pulls Observables out of it as Bulk Lookup does. Values the action doesn't take are skipped with the reason, and the rest go ahead.
- **New values are held.** Running an action on a value the Organization doesn't hold yet holds it as an Observable with no Case, as marking one Important already does. It is searchable and has its own page.
- **A Case is optional.** Choosing a Case links each value to it by hand first and then takes the action from that Case, exactly as its own menu would. A Response Action then appears on the Case's Timeline and its Response Actions.
- **Response Actions without a Case.** This is the change to ADR 0007, which said a Response Action is always taken from a Case and removable only by the Case that created it. Without a Case:
  - The Member must give a reason. It replaces `C-<n>: <title>` as the IOC description, the blocked sender's description and the destination's comment, followed by a link to the Action Log.
  - It goes through the same outbox, already-present rules and removal as any other. Each change is recorded in the Organization Audit Log (category `response-actions`) rather than on a Case's Timeline and Case Audit Log.
  - Any Member removes, retries or dismisses it from the Action Log.
  - Linking it to a Case later moves it to that Case for good. It is recorded there, appears on that Case's Timeline from then on, and can be removed only from that Case. A Response Action taken from a Case is never unlinked.
- **Containment still needs a Case.** Contain host and Lift containment keep ADR 0009's confirmation, which reads the host's devices from Falcon afresh. The Action Center asks for a Case and a host, links the host to that Case, and opens the same confirmation.
- **The Action Log records:**
  - every Response Action, taken from a Case or from the Action Center (its row shows the Response Action's current state);
  - every Mark Important, unmark, Ignore and un-Ignore, wherever it was done;
  - every lookup run from the Action Center, with whether it was answered from the cache or failed.
  Lookups made by opening the Enrichment panel or an Observable's page are not recorded. They happen every time a panel opens, and ADRs 0010–0012 decided they change nothing worth recording.
- **The Action Log is not an Audit Log.** It is the record of runs that Members work from: what ran, on what, through which Integration, for which Case, by whom, from where, and with what result. The Audit Logs stay the immutable record (ADR 0003). A row is never deleted; only its Case can be set, once, by linking it.
- **Seen as the Cases are.** A row linked to a Case the viewer can't see (a Restricted Case) is left out, so its value doesn't leak which Restricted Cases exist.

## Considered Options

- **Requiring a Case for every Response Action, as ADR 0007 did**: rejected. Blocking a sender that a dozen people reported shouldn't wait for someone to open a Case. The reason field and the Organization Audit Log keep the action accountable.
- **Logging every lookup, hovers and panels included**: rejected. It would bury the runs Members chose among thousands of automatic reads.
- **A separate table per kind of run**: rejected. The log is one list, filtered by kind, and Response Actions keep their own table; the log row points at the Response Action rather than copying its state.
- **Failure notifications for Response Actions without a Case**: deferred. Notifications belong to a Case today. A Failed one shows in the Action Log, and the Action Log tab counts what changed since the Member last looked.

## Consequences

- `response_actions.case_id` is nullable, and a Response Action without one must carry a `reason`.
- The worker's sender takes Response Actions without a Case. They are described by their reason and recorded in the Organization Audit Log.
- A Response Action without a Case notifies nobody when it fails.
- Response Actions that Argus already sent from the Action Center count as "already present" for Cases, and the other way round, as between two Cases. Removing one that other Cases rely on asks for confirmation, as before.
