# Argus

A collaborative case management workspace where an in-house security team investigates, coordinates and records its response to security matters.

## Language

### Tenancy and people

**Organization**:
The in-house security team (and the company it protects) that uses Argus; the unit of tenancy and data isolation.
_Avoid_: Tenant, account, workspace, company, client

**Operator**:
A person who runs the Argus service itself and creates Organizations; not a member of any Organization and distinct from an Admin.
_Avoid_: Super admin, platform admin, staff

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

**Guest grant**:
What lets a Guest into one Case: given by an Admin or the Case's Assignee, optionally until an expiry, and ended when the Guest is removed.
_Avoid_: Share, invitation, access token

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

**Case Type**:
The kind of security matter a Case is, from a fixed list: Phishing, Malware, Account Compromise, Unauthorized Access, Data Loss, Insider Threat, Denial of Service, Vulnerability or Other.
_Avoid_: Category, classification, incident type

**Severity**:
How serious a Case is: Critical, High, Medium, Low or Informational.
_Avoid_: Priority, impact, SEV level

**Restricted Case**:
A Case hidden from Analysts unless they are assigned to it; Admins and assigned Guests can still see it.
_Avoid_: Private case, confidential case, locked case

**Assignee**:
The one person accountable for driving a Case forward; a Case with no Assignee is unassigned. Alerts have no Assignee.
_Avoid_: Owner, lead, handler

**Case Role**:
An Organization-defined function (e.g. Lead, Forensics, Comms, Legal) that a Member or Guest can be given on a particular Case.
_Avoid_: Position, responsibility

**Task**:
A unit of work on a Case with a single owner and a done/not-done state.
_Avoid_: Action item, to-do, subtask

**Case Link**:
A typed relationship between two Cases: Related, Duplicate of, or Parent/Child. Marking a Case Duplicate of another closes it with Resolution Duplicate.
_Avoid_: Relation, association, merge

**Tag**:
A short free-form label on a Case (e.g. #bec, #legal-hold) used to group and filter Cases; written in lowercase without the "#".
_Avoid_: Label, category, keyword

**Internal**:
A marking on an item within a Case that hides it from Guests on that Case.
_Avoid_: Private, hidden, confidential

### Alerts

**Alert**:
A detection raised by an external security tool (e.g. CrowdStrike) and received by Argus; it is not a Case and is never worked on its own, only attached to a Case (at most one at a time) or dismissed.
_Avoid_: Detection, event, signal, case

**Alert Status**:
Where an Alert stands: New, Attached (to a Case) or Dismissed. Its status, assignee and tags in Falcon are mirrored alongside but are not its Alert Status.
_Avoid_: Alert state

**Dismissal Reason**:
Why an Alert was dismissed without being attached to a Case: False Positive, Benign, Duplicate or Other.
_Avoid_: Close reason, suppression

**Integration**:
An Organization's connection to an external security tool, from a Provider such as CrowdStrike or Mimecast; depending on the Provider it receives Alerts, writes changes to those Alerts back, and takes Response Actions.
_Avoid_: Connector, source, plugin, feed

**Provider**:
The external security tool an Integration connects to, which fixes what that Integration can do.
_Avoid_: Vendor, platform, connector type

**Correlation**:
A suggestion that an Alert belongs with a Case because the Alert names Observables or Assets already linked to it, names a Falcon device recorded on a host linked to it whatever the host is now called, or names an account whose Identity Protection identity is recorded on an account linked to it whatever either is called; Argus only suggests, and an Analyst decides whether to attach.
_Avoid_: Match, auto-link, cluster

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

**Case Summary**:
The single, current rich-text overview of a Case (what is known so far, handover notes), edited by one person at a time.
_Avoid_: Description, notes, overview, brief

**Case Report**:
An exported, point-in-time document summarising a Case, either complete or Guest-safe (excluding Internal items).
_Avoid_: Export, post-mortem, write-up

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

**Enrichment**:
What an Integration's tool or another source Argus looks things up in currently reports about an Asset, an IP address or a file, such as a host's OS, last-seen time and containment, an identity's risk, where an IP is and which network runs it, or how many VirusTotal engines flag a file by its hash, or a domain or URL, and when a domain was registered, shown as of when Argus last fetched it.
_Avoid_: Context, intel, details, lookup

**Ignored Observable**:
An Observable (or Asset) an Admin has marked as too common to mean anything, such as a public resolver or the Organization's own mail domain; still held, linked and searchable, but never the basis of a Correlation.
_Avoid_: Allowlist, whitelist, suppressed, excluded

**Bulk Lookup**:
Pasting free text into Argus to pull out every Observable it contains and see which are already known, and where.
_Avoid_: IOC check, mass search

**Response Action**:
An action Argus takes in an external tool against one Observable or host linked to a Case, through an Integration, such as adding a custom IOC to Falcon, blocking a sender in Mimecast or containing a host; always taken from a Case, and removable only by the Case that created it.
_Avoid_: Block, push, playbook, remediation

**Containment**:
Cutting a host off the network through an Integration, taken as a Response Action; lifting it ends it, and an Admin may lift Containment that Argus did not impose.
_Avoid_: Isolation, quarantine, network contain
