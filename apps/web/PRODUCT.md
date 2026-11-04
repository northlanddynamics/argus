# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: Analysts on an in-house security team, working the Alert queue and their Cases at a desktop for hours at a stretch. Argus is their daily workspace, not something they open now and then.

Secondary:
- Admins, who manage the Organization's Members, settings, Integrations (CrowdStrike, Teams channel) and SAML SSO, and can see every Case, including Restricted ones.
- Guests from outside the Organization (outside counsel, insurers, external IR firms), who see only the Cases they have a Guest grant for. They post in the Discussion, own and complete Tasks, add Evidence and export Guest-safe Case Reports.
- Operators, who run the service and create Organizations from the operator console.

Vocabulary follows `GLOSSARY.md` at the repository root (Case, Alert, Member, Guest, Severity, Status, Resolution and so on). UI copy uses those terms and avoids the words it lists under "Avoid" (for example "incident", "ticket", "user").

## Product Purpose

Collaborative security case management for in-house teams: one place where a team investigates, coordinates and records its response to security matters, from a phishing report or a suspicious alert through to a full breach. It is working well when Analysts can move through Alerts and Cases quickly and without friction, and the Case is the shared, complete record of what happened.

## Positioning

Argus doesn't have to stand out from TheHive, ServiceNow SecOps, Jira or spreadsheets on novelty. It has to be functional and easy to use. Within that, three strengths are worth making obvious:

- **Safe outside collaboration:** Guests work inside the Case itself, while items marked Internal never reach them.
- **Alert-to-Case flow:** CrowdStrike Falcon detections arrive as Alerts with their Observables and Assets already extracted. Members open Cases from them or attach them to existing Cases, and with write-back on, those changes are sent back to Falcon.
- **Live teamwork:** presence and real-time updates, so several people can work one Case at the same time.

## Operating Context

- Organizations are independent in-house teams; there is no MSSP or client layer (ADR 0004). Outside parties take part only as Guests on specific Cases.
- Daily flow: triage the Alert queue → open a Case from selected Alerts or attach them to one → work it through Status (New, Triage, In Progress, Awaiting Info, Resolved, Closed) with Tasks, Discussion, Timeline Entries, Evidence, Observables, Assets and Case Links → close it with a Resolution.
- Members are notified in the app (bell and toasts) and by email, and new Critical Cases are posted to the Organization's Teams channel.
- Global search sits in the header (`/` focuses it).
- Sign-in: password plus TOTP, passkeys, or SAML SSO. Guests sign in on a separate page.
- Case Reports are exported as PDF (A4) or Markdown, in a complete or a Guest-safe variant.

## Capabilities and Constraints

- Stack: Vite + React SPA with shadcn/ui, TanStack Router and TanStack Query, typed against the Hono API through Hono RPC. Add shadcn/ui components with `bunx shadcn@latest add`, never by copying them in by hand.
- Nothing is hard-deleted: Evidence is written once and can't be altered, and actions are recorded in Case or Organization Audit Logs, kept separate from the Timeline (ADR 0003). The UI must not suggest anything can be erased.
- Restricted Cases and Internal items must never leak to people who can't see them, in any view, search result, notification or export.
- Bulk Alert actions can partly fail: Alerts that changed since the Member saw them are refused one by one while the rest are applied. The UI has to report that per Alert.
- Open: which screen sizes are supported (not decided), and whether a formal accessibility standard is required (none set).

## Brand Commitments

The name is Argus, and the only asset is the current favicon (`public/favicon.svg`). There is no logo, brand guide or voice guide yet.

## Evidence on Hand

None. There are no customers, testimonials, case studies, metrics or press to cite. Future work must not invent any.

## Product Principles

1. **Usable before distinctive.** Analysts live in Argus all day, so clarity, speed and familiar patterns come first.
2. **The Case is the record.** What happened, who did it and when must always be visible and traceable.
3. **Show who can see what.** Internal and Restricted status and Guest visibility are always clear, so nothing is shared by accident.
4. **Alerts flow into Cases.** Getting from a detection to a worked Case takes as few steps as possible.
5. **Built for working together.** Other people's presence and changes show up live, without a reload.
