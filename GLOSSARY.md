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
Where a Case currently stands in the Organization's workflow (e.g. New, In Progress, Awaiting Info, Closed); each Status belongs to exactly one Status Category.
_Avoid_: State, phase, stage

**Status Category**:
One of the fixed groupings Open, Active or Closed that every Status maps to, so Cases can be compared across differently named Statuses.
_Avoid_: Status type

**Severity**:
How serious a Case is: Critical, High, Medium, Low or Informational.
_Avoid_: Priority, impact, SEV level

**Restricted Case**:
A Case hidden from Analysts unless they are assigned to it; Admins and assigned Guests can still see it.
_Avoid_: Private case, confidential case, locked case

**Assignee**:
The one person accountable for driving a Case forward; a Case with no Assignee is unassigned.
_Avoid_: Owner, lead, handler

**Case Role**:
An Organization-defined function (e.g. Lead, Forensics, Comms, Legal) that a Member or Guest can be given on a particular Case.
_Avoid_: Position, responsibility

**Task**:
A unit of work on a Case with a single owner and a done/not-done state.
_Avoid_: Action item, to-do, subtask
