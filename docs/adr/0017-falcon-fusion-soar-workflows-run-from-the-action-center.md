# Falcon Fusion SOAR Workflows are discovered, run from the Action Center and watched to their outcome

Falcon Fusion SOAR lets a CrowdStrike tenant build workflows: chains of actions in Falcon and beyond, such as containing a host, opening a ticket or posting to a channel. Analysts want to run the on-demand ones from where they work in Argus and see how each run went, without switching to the Falcon console.

A **Workflow** is a Falcon Fusion SOAR workflow definition discovered through a CrowdStrike Integration. A **Workflow Run** is one execution of one that a Member asked Argus for.

## Decisions

- **Discovery.** The worker lists each CrowdStrike Integration's workflow definitions every 15 minutes, or sooner when any Member presses Refresh. It records each one's name, description, whether it is on in Falcon, whether its trigger is On demand, and the inputs that trigger's schema declares. A definition Falcon stops listing is kept, marked removed, since runs name it. Discovery only reads, so like Enrichment (ADR 0009) it needs no Admin setting, only Workflow: Read. A missing scope shows on the Integration and in the Action Center, and what was discovered before stays.
- **Running is a per-Integration setting**, Workflows, off until an Admin turns it on, separate from Response Actions and Host containment. It needs Workflow: Write. Turning it on or off is recorded in the Organization Audit Log.
- **Only on-demand Workflows run**, as Falcon's API allows, and only while they are on in Falcon and the Integration is neither paused nor has Workflows off. The Action Center lists the others and says why they can't run.
- **Any Member runs one** from the Action Center's Workflows section, with a field per declared input (or free JSON when the trigger declares none Argus can read). Inputs are checked against the declaration before anything is queued. Guests never see Workflows or their runs.
- **A Case is optional, as for Response Actions (ADR 0016).** With one, the run is recorded in the Case's Audit Log, and a Closed Case refuses it. Without one, the Member gives a reason, and the run is recorded in the Organization Audit Log under `workflows`. A run without a Case can be linked to one later from the Action Log, for good.
- **Runs go through the worker.** Running queues the run, in the transaction that records it, and the worker sends it. Sending is tried **once**: running a workflow isn't idempotent, so Argus never resends on its own. When Falcon can't be asked (a refusal, a missing scope, a timeout), the run is Failed with why, and any Member who can see it may Retry it.
- **Argus watches each run to its outcome.** The worker reads the execution's results 5 seconds after sending, then at doubling intervals up to every 5 minutes. It records Falcon's status, each step and what the run returned (cut at 32 KB) as it goes, and signals the Action Center, so an open run updates live. Once Falcon reports it Completed, Failed or Cancelled, the run takes that state and is not read again. A failed read is tried at the next check. After 7 days without an outcome Argus stops watching, and the run shows No outcome.
- **The outcome is recorded.** The run's Audit Log records when it ended and how. A run for a Case that Failed, or got no outcome, notifies the Member who ran it. A Cancelled run notifies nobody, since someone cancelled it in Falcon on purpose.
- **The Action Log lists every run** (kind Workflows) and shows its current state, as it does for Response Actions. From there a Member can open the run's steps and output, Retry one Falcon couldn't be asked for, run the Workflow again with the same inputs, or link a run without a Case to one.

## Considered Options

- **Retrying sends with backoff, as the Response Action outbox does**: rejected. A timed-out request may still have started the workflow, and running it twice can do real harm. A Member decides.
- **Running Workflows from a Case's Observables menu with the value as input**: deferred. Inputs are free-form per workflow, and mapping Observables onto them needs its own design. The Action Center's Case link covers recording.
- **Cancelling a running Workflow from Argus**: deferred. Falcon has an execution action for it, but cancelling midway leaves whatever ran so far in place, and the confirmation needs thought.
- **Discovery only while Workflows is on**: rejected. Seeing what exists is what tells an Admin whether turning it on is worth it, and it only reads.
- **Watching runs forever**: rejected. Some workflows wait on approvals, but a run with no outcome after 7 days has stopped being something anyone is waiting on in Argus.

## Consequences

- A CrowdStrike Integration now also lists workflows (Workflow: Read) and, once an Admin allows it, runs them (Workflow: Write). These are scopes and a consent separate from those of ADRs 0002, 0007 and 0009.
- A Workflow can do anything it was built to do, and nothing Argus does undoes it. Argus records who ran what, with which inputs, for which Case or reason, and how it ended. It never claims to know what the workflow changed beyond the steps Falcon reports.
- Pausing an Integration also pauses watching its runs. They resume when it does, and still give up after 7 days.
- The Falcon Fusion SOAR endpoints used (`/workflows/combined/definitions/v1`, `/workflows/entities/execute/v1`, `/workflows/entities/execution-results/v1`) are read leniently, as the rest of the Falcon client is, and are unverified against a live tenant.
