# Argus

A collaborative case management workspace where an in-house security team investigates, coordinates and records its response to security matters.

## Language

### Tenancy and people

**Organization**:
The in-house security team (and the company it protects) that uses Argus; the unit of tenancy and data isolation.
_Avoid_: Tenant, account, workspace, company, client

**Member**:
A person who belongs to an Organization with one of the roles Owner, Admin or Analyst.
_Avoid_: User, employee, staff

**Owner**:
The single Member ultimately responsible for an Organization, who alone can delete it or transfer ownership.
_Avoid_: Super admin

**Admin**:
A Member who manages the Organization's Members, settings and configuration, and can see every Case including Restricted ones.
_Avoid_: Manager

**Analyst**:
A Member who works Cases; sees every non-Restricted Case in the Organization.
_Avoid_: Responder, investigator, agent

**Guest**:
A person from outside the Organization (e.g. outside counsel, insurer, external IR firm) granted access to specific Cases only, never to the Organization as a whole.
_Avoid_: External user, collaborator, contractor, viewer

### Cases

**Case**:
A security matter the Organization is tracking and working, from a phishing report or suspicious alert through to a full-blown breach.
_Avoid_: Incident, ticket, issue, alert, event

**Status**:
Where a Case currently stands, from a fixed list: New, Triage, In Progress, Awaiting Info, Resolved (work done, awaiting review) or Closed (final and read-only unless an Admin reopens it).
_Avoid_: State, phase, stage

**Resolution**:
The outcome recorded when a Case is closed: True Positive, Benign, False Positive or Duplicate.
_Avoid_: Disposition, verdict, outcome, close reason

**Severity**:
How serious a Case is: Critical, High, Medium, Low or Informational.
_Avoid_: Priority, impact, SEV level

**Restricted Case**:
A Case hidden from Analysts unless they are assigned to it; Admins and assigned Guests can still see it.
_Avoid_: Private case, confidential case, locked case

**Assignee**:
The one person accountable for driving a Case forward, or for triaging an Alert; with none, the Case or Alert is unassigned.
_Avoid_: Owner, lead, handler

**Case Role**:
An Organization-defined function (e.g. Lead, Forensics, Comms, Legal) that a Member or Guest can be given on a particular Case.
_Avoid_: Position, responsibility

**Task**:
A unit of work on a Case with a single owner and a done/not-done state.
_Avoid_: Action item, to-do, subtask

**Case Link**:
A typed relationship between two Cases: Related, Duplicate of, or Parent/Child.
_Avoid_: Relation, association, merge

**Internal**:
A marking on an item within a Case that hides it from Guests on that Case.
_Avoid_: Private, hidden, confidential

### Alerts

**Alert**:
A detection raised by an external security tool (e.g. CrowdStrike) and received by Argus; it is not a Case, and is attached to at most one Case at a time.
_Avoid_: Detection, event, signal, case

**Alert Status**:
Where an Alert stands in triage: New, Acknowledged, Attached (to a Case) or Dismissed.
_Avoid_: Alert state

**Dismissal Reason**:
Why an Alert was dismissed without being attached to a Case: False Positive, Benign, Duplicate or Other.
_Avoid_: Close reason, suppression

**Integration**:
An Organization's connection to an external security tool through which that tool sends Alerts into Argus.
_Avoid_: Connector, source, plugin, feed

### Record of a Case

**Timeline**:
The analyst-written account of what happened in the real world during a Case, ordered by when things happened rather than when they were recorded.
_Avoid_: Narrative, chronology, history

**Timeline Entry**:
One real-world occurrence on the Timeline, with an occurred-at time that may be exact, a range or approximate, and a separate recorded-at time.
_Avoid_: Event, key event, log entry

**Audit Log**:
The immutable, system-written record of every action taken on a Case within Argus, including who accessed or exported Evidence.
_Avoid_: History, activity feed, timeline, change log

**Discussion**:
The conversation among the people working a Case.
_Avoid_: Chat, comments, thread

**Promotion**:
Turning a Discussion message or Audit Log entry into a Timeline Entry that links back to its source.
_Avoid_: Pinning, highlighting

### Evidence and context

**Evidence**:
Any file added to a Case; fingerprinted when added, never altered afterwards, and every access to it is recorded in the Audit Log.
_Avoid_: Attachment, file, artifact, upload

**Observable**:
An indicator such as an IP address, domain, hash or email address, held once per Organization and linked to every Case it appears in.
_Avoid_: IOC, indicator, artifact, entity

**Asset**:
A thing the Organization owns or operates, such as a host or account, held once per Organization and linked to every Case that affects it.
_Avoid_: Device, system, resource, entity
