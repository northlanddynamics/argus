# Argus

A collaborative workspace where an in-house security team declares, coordinates and records its response to cybersecurity incidents.

## Language

### Tenancy and people

**Organization**:
The in-house security team (and the company it protects) that subscribes to Argus; the unit of tenancy and data isolation.
_Avoid_: Tenant, account, workspace, company, client

**Member**:
A person who belongs to an Organization and can, subject to their role, see that Organization's Incidents.
_Avoid_: User, employee, staff

**Guest**:
A person from outside the Organization (e.g. outside counsel, insurer, external IR firm) granted access to specific Incidents only, never to the Organization as a whole.
_Avoid_: External user, collaborator, contractor, viewer

### Incidents

**Incident**:
A cybersecurity event that a Member has declared as requiring a coordinated response, and the record of that response.
_Avoid_: Case, ticket, issue, alert, event

**Declaration**:
The deliberate act by a Member of opening an Incident.
_Avoid_: Creation, escalation, promotion
