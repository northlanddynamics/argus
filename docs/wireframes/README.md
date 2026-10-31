# Argus v1 wireframes

Low-fidelity wireframes for every major component of the v1 spec (#1). Vocabulary follows `GLOSSARY.md`; behaviour shown follows ADRs 0001–0005.

- **Live canvas** (clickable, comment-able): https://claude.ai/artifact/FNu6UXi5WuxRnFDGPuFWmU
- **`png/`**: static renders at 1280 px wide, one per screen.
- **`src/`**: the source of each screen (`.dc.html`, the canvas's component format).
- **`render/`**: regenerates `png/` from `src/` with the pre-installed Playwright: `node docs/wireframes/render/render.mjs`.

Sample names and numbers are illustrative only. Hatched boxes are placeholders for content not designed yet.

## Conventions

| Mark | Meaning |
| --- | --- |
| Solid black badge | Severity Critical |
| Heavy outline badge | Severity High (others: thin outline) |
| Dashed badge | Internal (hidden from Guests) |
| Lock icon | Restricted Case |
| Blue button | Primary action |
| Yellow banner | Refused stale save / partial bulk refusal / stream gap |

## Screens → issues

| Screen | Wireframe | Issues |
| --- | --- | --- |
| Case list (My Cases, Unassigned, filters, Tags) | [png](png/Main.png) · [src](src/Main.dc.html) | #5 #7 #8 #14 |
| Case page · Overview (header, Case Summary with stale-save refusal, Case Roles, Guests, Linked Cases, Tags, presence) | [png](png/Case.png) · [src](src/Case.dc.html) | #5 #6 #7 #8 #9 #14 #15 |
| Case · Timeline & Discussion (occurred-at modes, citations, Promotion, retraction, @mentions, Falcon comments) | [png](png/Timeline.png) · [src](src/Timeline.dc.html) | #10 #11 #18 #22 |
| Case · Tasks, Evidence, Observables & Assets | [png](png/CaseWork.png) · [src](src/CaseWork.dc.html) | #9 #12 #13 #18 #19 |
| Case · Audit Log | [png](png/AuditLog.png) · [src](src/AuditLog.dc.html) | #5 #11 #20 |
| Alert queue (filters, bulk bar, partial-refusal notice, Alert detail) | [png](png/AlertQueue.png) · [src](src/AlertQueue.dc.html) | #16 #17 #18 #19 #22 |
| Alert dialogs (Open Case, Attach, Dismiss, Move/Detach) | [png](png/AlertDialogs.png) · [src](src/AlertDialogs.dc.html) | #17 #21 |
| Case dialogs (Close with Resolution, Link Cases, Invite Guest, Export Case Report) | [png](png/CaseDialogs.png) · [src](src/CaseDialogs.dc.html) | #6 #14 #15 #21 #26 |
| Global search | [png](png/Search.png) · [src](src/Search.dc.html) | #27 |
| Notifications (bell, toasts, email, Teams post) | [png](png/Notifications.png) · [src](src/Notifications.dc.html) | #8 #23 #24 |
| Metrics dashboard | [png](png/Dashboard.png) · [src](src/Dashboard.dc.html) | #28 |
| Guest view of a Case | [png](png/GuestView.png) · [src](src/GuestView.dc.html) | #15 #18 #26 |
| Sign-in flows (password + TOTP, enrolment, passkey, SSO, Guest magic link) | [png](png/SignIn.png) · [src](src/SignIn.dc.html) | #2 #3 #15 #25 |
| Settings · Members, Case Roles, SSO, Ownership | [png](png/Members.png) · [src](src/Members.dc.html) | #3 #4 #9 #25 |
| Settings · Integrations & Teams channel | [png](png/Integrations.png) · [src](src/Integrations.dc.html) | #16 #21 #24 |
| Settings · Organization Audit Log | [png](png/OrgAudit.png) · [src](src/OrgAudit.dc.html) | #4 #16 |
| Operator console | [png](png/Operator.png) · [src](src/Operator.dc.html) | #2 |

## Issues → screens

| Issue | Screens |
| --- | --- |
| #2 Walking skeleton: Operator creates an Organization, Owner signs in | Operator console, Sign-in |
| #3 Member sign-in hardening: mandatory TOTP and passkeys | Sign-in, Settings · Members |
| #4 Members and Organization Audit Log | Settings · Members, Settings · Organization Audit Log |
| #5 Cases core: open, list, view, assign, with the Case Audit Log | Case list, Case page, Case · Audit Log |
| #6 Case closure: Resolution, read-only Closed Cases, Admin reopen | Case dialogs (Close), Case page |
| #7 Access policy module and Restricted Cases | Case page (Restricted toggle), Case list (lock) |
| #8 Real-time foundation: live signals and presence avatars | Case page (Viewing now), Case list (Live), Notifications (reconnect toast) |
| #9 Tasks and Case Roles | Case · Tasks, Case page (Case Roles), Settings · Members (catalog) |
| #10 Discussion with @mentions | Case · Timeline & Discussion |
| #11 Timeline and Promotion | Case · Timeline & Discussion, Case · Audit Log |
| #12 Evidence: fingerprinted, immutable, access-logged files | Case · Evidence |
| #13 Observables and Assets with cross-Case correlation | Case · Observables & Assets |
| #14 Case Links and Tags | Case page, Case dialogs (Link), Case list |
| #15 Guest access: magic-link invites scoped to individual Cases | Case dialogs (Invite Guest), Guest view, Sign-in, Case page |
| #16 CrowdStrike Integration and Event Streams ingest | Settings · Integrations, Alert queue, Organization Audit Log |
| #17 Alerts to Cases: bulk open, attach, move, dismiss | Alert queue, Alert dialogs |
| #18 Internal items and Guest visibility | Timeline & Discussion, Tasks/Evidence, Alert queue, Guest view |
| #19 Observable and Asset extraction from Alerts | Alert queue (detail), Case · Observables & Assets |
| #20 Falcon inbound updates | Case · Audit Log |
| #21 Falcon write-back outbox | Settings · Integrations, Alert dialogs, Case dialogs (Close) |
| #22 Falcon comment sync into the Discussion | Timeline & Discussion, Alert queue (detail) |
| #23 Notifications: in-app, toasts and email | Notifications |
| #24 Teams channel notifications | Settings · Integrations, Notifications |
| #25 SAML SSO per Organization | Settings · Members (SSO), Sign-in |
| #26 Case Reports | Case dialogs (Export), Guest view |
| #27 Global search | Global search |
| #28 Metrics dashboard | Metrics dashboard |
