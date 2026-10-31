# CrowdStrike sync: Event Streams in, Falcon API out

Each CrowdStrike Integration holds Falcon API credentials and syncs two ways. Inbound, Argus consumes the Falcon Event Streams API as its only feed: detection summary events (`EppDetectionSummaryEvent`, `IdpDetectionSummaryEvent`, `MobileDetectionSummaryEvent`) create Alerts keyed by `CompositeId`, and `UserActivityAuditEvent` with `OperationName=detection_update` applies status, assignee and tag changes made in Falcon. Outbound, Argus writes Alert Status, Assignee, comments and Case closure back through `PATCH /alerts/entities/alerts/v3`. Conflicts resolve as last-write-wins, with inbound changes recorded in the Audit Log attributed to CrowdStrike.

## Considered Options

- **Fusion webhook for new Alerts**: rejected; Fusion has no alert-update trigger, so it could only ever be half the sync.
- **Polling the Alerts API**: rejected in favour of the stream's completeness and near-real-time delivery, including as a fallback for customers without Event Streams and as a backfill after outages.

## Consequences

- Customers whose Falcon subscription lacks Event Streams cannot connect an Integration.
- The worker resumes each stream from its last stored offset. An outage longer than Falcon's replay window loses the Alerts raised during it; the gap is recorded in the Organization Audit Log, not backfilled.
- Comments made in Falcon are not reliably in the stream. Argus fetches an Alert's comments via the Alerts API when a `detection_update` event arrives for it and whenever the Alert or its Case is opened in Argus.
- Only Alert-related events are consumed in v1; other Falcon activity (containment, RTR, console audit) is ignored.
