# Action Center: wireframes

Where a Member sees every action Argus can take on an Observable or Asset, runs any of them on whatever values they paste, with or without a Case, and finds every action anyone has taken in the Action Log. Today each action lives where its Observable is shown with its Case: the "Take action" menu (ADR 0008), Contain host (ADR 0009), the Enrichment panel's lookups (ADRs 0010–0012, 0014), Mark Important and Ignore. Analysts want one place to act on a value from a Slack thread or a vendor report before there is a Case, and to see what was done, by whom and where.

Interactive version: https://claude.ai/artifact/PrJiJ8ew6JKZjtm1rSSEfV

## Behaviour

- **Where it lives.** "Actions" in the main sidebar under Alerts, at `/actions`. Members only: Guests get no nav item and the route refuses them, as they get no lookups or Response Actions today.
- **Value box.** Pasting a value highlights the actions that take its type and dims the rest. Defanged values (`hxxps`, `[.]`) are refanged as Bulk Lookup does. `Enter` opens the first highlighted action that can run, with the value filled in.
- **One card per action per Integration.** Two Falcon tenants show two "IOC alert" cards, each naming its Integration. A card lists the types it takes and whether it can run now: Ready, Response Actions off, no destination list chosen, no VirusTotal key, paused. A card that can't run still opens its dialog, which says why and where an Admin fixes it.
- **Three groups**, by what an action changes:
  - **Respond** (writes to a tool, removable): IOC alert, IOC block, Block sender, Block domain, Add to destination list, Contain host, Lift containment (Admin).
  - **Look up** (reads only): IP details (IPinfo), File reputation and Domain & URL reputation (VirusTotal, the Member's key), Destination list check (Umbrella), Host & identity details (Falcon).
  - **Mark** (changes how Argus treats the value): Mark Important, Ignore (Admin).
- **The dialog takes any input**: one or many values, one per line or pasted free text. Each is listed with its detected type; what the action doesn't take is struck through with the reason ("Falcon takes no URL"), and the button counts only what will go.
- **Case is optional.** Default "No Case". Picking a Case links any value not yet on it as an Observable, puts the action on its Timeline and Response Actions, and offers Internal. Without a Case a Response Action needs a reason, sent as the IOC description or block comment in place of `C-<n>: <title>`.
- **Same rules as from a Case.** The Integration's one-click defaults (severity, platforms, destination list) are shown in the dialog. "Already present" still records and sends nothing. Contain host still refetches and confirms the host. Admin-only actions are marked "Admin" and disabled for Analysts.
- **Lookups** show their result in the dialog, each value opening in the Enrichment panel.

### Action Log

- **Every run of every action**, whoever took it and wherever from: this page, a Case's ⋯ menu, an Observable's page, the Enrichment panel's Refresh. One row per value per action, newest first, kept for good.
- **Columns**: When, Action (with the reason for a Case-less Response Action), Value, Through (Integration), Case, By, From, State, ⋯.
- **Filters**: Linked to a Case / No Case, kind (Respond, Look up, Mark), action, Member, state.
- **State**: Response Actions keep theirs (Pending, Active, Removing, Removed, Failed, with the error). Lookups and marks show Done, Cached or Failed.
- **Row menu**: Retry, Remove…, Dismiss record…, Link to Case…, Open Observable, as the row allows.
- **Linking later.** A row with no Case offers "Link to Case…". Linking moves a Response Action onto that Case: it then appears on its Timeline and is removable from it.
- **Restricted Cases.** A row on a Restricted Case the Member can't see shows "Restricted Case" with no number.

## A. The page

```
┌ sidebar ──┬──────────────────────────────────────────────────────────────────────────────────┐
│ Argus     │ Acme / Actions                                                                   │
│ Dashboard ├──────────────────────────────────────────────────────────────────────────────────┤
│ Search    │ Action Center                                                                    │
│ Alerts    │ Look up, respond to and mark any value, with or without a Case.                  │
│▌Actions   │ ┌──────────────────────────────────────────────────────────────────────────────┐ │
│           │ │ Value [ invoice-portal[.]biz                          ]  Domain · 6 actions  │ │
│ Your Cases│ └──────────────────────────────────────────────────────────────────────────────┘ │
│ C-12 …    │ RESPOND · writes to an external tool; removable                                  │
│ C-15 …    │ ┌ IOC alert ─────────┐ ┌ IOC block ─────────┐ ┌ IOC alert ─────────┐ ┌ Block … ┐ │
│           │ │ CrowdStrike·US-1   │ │ CrowdStrike·US-1   │ │ CrowdStrike·EU-1   │ │ Mimecast│ │
│           │ │ (SHA-256)(MD5)(Dom)│ │ (SHA-256)(MD5)     │ │ (SHA-256)(MD5)(Dom)│ │ (Email) │ │
│           │ │ ● Ready     [Run…] │ │ ● Ready     [Run…] │ │ ○ Response Actions │ │ ● Ready │ │
│           │ └────────────────────┘ └────────────────────┘ │   off       [Run…] │ └─────────┘ │
│           │   … Block domain · Add to destination list · Contain host · Lift containment [Admin]
│           │ LOOK UP · reads only; changes nothing anywhere                                   │
│           │   IP details · File reputation · Domain & URL reputation · Destination list check│
│           │   · Host & identity details                                                      │
│           │ MARK · changes how Argus treats the value                                        │
│           │   Mark Important · Ignore [Admin]                                                │
│           │                                                                                  │
│           │ Action Log    [All|Linked|No Case] [All kinds|Respond|Look up|Mark] Action▾ By▾  │
│           │ When     Action            Value              Through   Case       By   State    │
│           │ 4 min    IOC alert         185.220.101.4      Falcon US-1 C-12     Ada  ● Active  │
│           │ 22 min   Block sender      billing@invoice-…  Mimecast  No Case ·  Sam  ● Active  │
│           │          "Reported by 14 users"                         Link to Case…            │
│           │ 2 h      Add to dest. list invoice-portal.biz Umbrella  No Case    Ada  ● Failed  │
│           │                                                                 Umbrella refused │
│           │ 5 h      IOC block         44d88612fea8…b02f  Falcon US-1 Restricted Jo ○ Removed │
└───────────┴──────────────────────────────────────────────────────────────────────────────────┘
```

## B. The run dialog

```
┌──────────────────────────────────────────────────────┐
│ IOC alert                                            │
│ CrowdStrike · Falcon US-1 · takes SHA-256, MD5,      │
│ Domain, IP                                           │
│                                                      │
│ Values · one per line, or paste any text             │
│ ┌──────────────────────────────────────────────────┐ │
│ │ a3f5c8e1…a4f6                                    │ │
│ │ 44d88612fea8a8f36de82e1278abb02f                 │ │
│ │ hxxps://invoice-portal[.]biz/login               │ │
│ └──────────────────────────────────────────────────┘ │
│  a3f5c8e1…a4f6                          (SHA-256)    │
│  44d88612fea8a8f36de82e1278abb02f       (MD5)        │
│  h̶t̶t̶p̶s̶:̶/̶/̶i̶n̶v̶o̶i̶c̶e̶-̶p̶o̶r̶t̶a̶l̶.̶b̶i̶z̶/̶l̶o̶g̶i̶n̶     Falcon takes no URL  │
│                                                      │
│  Action     Detect                                   │  ← the Integration's defaults,
│  Severity   The Case's, or High with no Case         │    shown, never hidden
│  Platforms  Windows, macOS, Linux                    │
│                                                      │
│ Case (optional)  [ No Case                       ▾ ] │
│ Reason  [ Why this is being blocked…               ] │  ← only with No Case; required
│ ☐ Internal: hide from the Case's Guests              │  ← only with a Case
├──────────────────────────────────────────────────────┤
│ Recorded in the Action Log and the Organization Audit Log │
│                     [Cancel] [Add to Falcon as Detect (2)] │
└──────────────────────────────────────────────────────┘
```

## Open questions

- **Response Actions without a Case.** ADR 0007 says a Response Action is always taken from a Case and removable only by the Case that created it; this page breaks both. Proposed: one with no Case belongs to the Action Center, any Member may remove it there, and linking it to a Case hands it over. Needs an ADR before building.
- **Logging lookups.** ADRs 0010–0012 keep lookups out of the Audit Log because they change nothing. Proposed: record them in the Action Log only, with cache hits shown as "Cached".
- **Values Argus doesn't hold yet.** Running an action on a new value with no Case: hold it as an Observable of the Organization with no Case, or keep it only on the log row? Proposed: hold it, so the log can link to its page.
