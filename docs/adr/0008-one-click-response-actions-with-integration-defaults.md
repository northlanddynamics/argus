# One-click Response Actions use per-Integration defaults

ADR 0007 fixed a Falcon custom IOC's severity to the Case's and its platforms to all of them, and every Response Action went through a dialog. Taking one now takes one click, from a "Take action" menu wherever an Observable is shown with its Case: the ⋯ button on its row and right-clicking the row, on the Case's Observables and Response Actions and on the Observable's own page, per Case it is on.

Under "Take action", per Integration that takes Response Actions:

- **IOC alert**: Falcon's Detect. Any Observable Falcon takes.
- **IOC block**: Falcon's Prevent. Hashes only, as before.
- **Remove IOC…**: what this Case created there. Still confirmed, and still names relying Cases.
- **Dismiss record…** for an "already present" record, and **Retry** for a Failed one.
- **More options…**: the full dialog, for several Integrations at once or an explicit Internal choice.

Ticking several Observables offers the same alert and block per Integration, leaving out what the Case already holds there.

So that one click needs no questions, each Integration carries defaults an Admin sets on Settings · Integrations: severity (the Case's, or a fixed one), platforms (at least one), and whether the Response Action starts Internal. They default to ADR 0007's behaviour. A Response Action records the severity and platforms it was taken with, so changing the defaults leaves queued and sent ones as they were. Changes are in the Organization Audit Log.

## Considered Options

- **A per-Organization default**: rejected. Two Falcon tenants can warrant different platforms or severities.
- **Asking per click with remembered last choice**: rejected. It is still a dialog, and what was last chosen is invisible to the next Member.
- **Host groups instead of global**: deferred. It needs Falcon's host groups listed in Argus first.
- **More Falcon actions** (Allow, No action, expiry): deferred. Allow suppresses detections, which is not a response, and ADR 0007 rejected expiry.

## Consequences

- This supersedes ADR 0007's "severity comes from the Case" and "every platform"; everything else in it stands.
- The menu always shows the Integration's severity and platforms, so a one-click IOC is never sent blind.
- Changing an IOC's action (alert to block) is Remove then send again, as it is in Falcon.
