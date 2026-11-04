# Argus

Collaborative security case management for in-house teams. Vocabulary: `GLOSSARY.md`. Decisions: `docs/adr/`.

## Layout

- `apps/api`: Hono API on Bun, Better Auth at `/api/auth/*`, Postgres via Drizzle. In production it also serves the built SPA.
  - `src/crowdstrike/`: the Falcon API adapter and the `worker` process's Event Streams ingest (ADR 0002).
  - `src/routes/`: HTTP only: validate, call a module, map its errors to status codes.
  - `src/cases/`, `src/tasks/`, `src/case-roles/`, `src/discussion/`, `src/timeline/`, `src/evidence/`, `src/observables/`, `src/case-links/`, `src/tags/`, `src/alerts/`, `src/internal/`, `src/integrations/`, `src/notifications/`, `src/teams/`, `src/members/`, `src/invitations/`, `src/organizations/`: one module per area of the domain, built in `src/modules.ts`; the only code that touches the database (ADR 0006).
- `apps/web`: Vite + React SPA (shadcn/ui, TanStack Router, TanStack Query), typed against the API through Hono RPC (`api/client`).

## Develop

```sh
bun install
cp .env.example .env               # then edit
bun --cwd apps/api db:migrate
OPERATOR_PASSWORD=... bun --cwd apps/api operator:create ops@example.com "Ops"
bun run dev:api                    # :3000
bun run dev:web                    # :5173, proxies /api to :3000
bun apps/api/src/worker.ts         # the worker: CrowdStrike Event Streams
```

## Checks

```sh
bun run lint
bun run typecheck
bun run test        # API tests against a real Postgres (TEST_DATABASE_URL, an admin connection)
bun run test:e2e    # builds the SPA, then a Playwright smoke test with the pre-installed Chromium
```

Members who sign in with a password must use TOTP: until they enroll, their session reaches only the enrollment endpoints (`apps/api/src/auth/totp-enrollment.ts`). Passkeys use `BASE_URL` as their origin and its hostname as the relying party ID, so set it to the public origin.

Evidence (`apps/api/src/evidence/`) is stored in an S3-compatible bucket through Bun's S3 client: set `S3_BUCKET` and its credentials (`S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; MinIO works locally). Without `S3_BUCKET` the app runs but Evidence uploads and downloads fail. Files are fingerprinted with SHA-256 as they stream in, written once under a fresh key and never overwritten or deleted; turn on S3 Object Lock for a bucket that can't be altered from outside Argus either. Bytes reach browsers only through the API, which records every view and download in the Case Audit Log first. `EVIDENCE_MAX_BYTES` caps a file (default 64 GiB).

CrowdStrike (ADR 0002): Admins add an Integration with Falcon API credentials (an API client with Event Streams read access), sealed at rest with AES-256-GCM under `CREDENTIALS_SECRET` (default `BETTER_AUTH_SECRET`). The `worker` process (`apps/api/src/worker.ts`, same image) claims each Integration's stream with a Postgres advisory lock, so exactly one worker reads it however many run; another takes over when it stops. It turns `EppDetectionSummaryEvent`, `IdpDetectionSummaryEvent` and `MobileDetectionSummaryEvent` into Alerts keyed by `CompositeId`, stores each event's offset with its result and resumes after it on reconnect, refreshes the stream session before Falcon's 30-minute expiry, and records a gap Falcon can no longer replay in the Organization Audit Log without backfilling it. Each Integration is read only unless an Admin turns on its write-back (`PUT /api/integrations/:id/write-back`, or the switch in Settings · Integrations); the change is recorded in the Organization Audit Log. With write-back on, attaching an Alert sets it `in_progress` in Falcon with a comment linking to the Case, dismissing one sets it `closed` with the Dismissal Reason as a comment, closing a Case closes its attached Alerts with the Resolution as a comment, and changing a Case's Assignee assigns its Alerts to the Falcon user with the same login email (skipped when there is none). Each change is queued in the `falcon_write_backs` outbox in the transaction that made it; the worker sends them (`crowdstrike/write-back.ts`), one Alert's changes in order, claiming batches with `FOR UPDATE SKIP LOCKED` so each is sent by one worker, retrying failures with backoff (30 s doubling to an hour, given up after 10), and cancelling any still unsent when write-back is turned off. Settings · Integrations shows the counts.

Alerts (`apps/api/src/alerts/`): Members open one Case from selected Alerts (its Severity defaults to the highest of theirs), attach them to a Case, move or detach them, and dismiss them with a Dismissal Reason. Every action names each Alert with the version the Member saw; bulk actions refuse, one by one, Alerts that changed since, and apply the rest. Attaching, moving and detaching are recorded in both Cases' Audit Logs, dismissals in the Organization Audit Log, and the database keeps an Alert on at most one Case. Each detection's Observables (hashes, remote IPs, DNS lookups) and Assets (hosts, accounts) are extracted as it arrives (`crowdstrike/indicators.ts`, fixtures in `crowdstrike/fixtures/`) and held once per Organization; attaching the Alert links them to the Case as "Alert (auto)", and detaching it unlinks them again unless they were added by hand or another Alert on the Case names them too.

Internal items (`apps/api/src/internal/`): Members mark Tasks, Discussion messages, Timeline Entries, Evidence and attached Alerts Internal, or show them to Guests again, each change in the Case Audit Log. Attaching an Alert makes it Internal. The access policy (`visibleItems`, `canSeeItem`) leaves Internal items out of every Guest read, including an entry's citations of Internal Tasks, and signals about Internal items alone (`membersOnly`) never reach Guests' sockets. Guests post in the Discussion, own and complete Tasks and add Evidence, but never on Internal items: an Internal item can't mention a Guest or be owned by one. Evidence stays unalterable apart from its marking (migration 0019).

Live updates (ADR 0005): each signed-in tab holds one WebSocket at `/api/live` (`apps/api/src/realtime/`). Changes publish a signal with `pg_notify` in the same transaction; every process listens and forwards it only to sockets whose Member can see the Case, and the SPA (`apps/web/src/lib/live.ts`) invalidates the matching queries. Presence is kept in `case_viewers`, refreshed by each process's heartbeat.

Notifications (`apps/api/src/notifications/`): people are notified in-app and by email when they are made a Case's Assignee or a Task's owner, when they are @mentioned, when a Guest is added to a Case they are Assignee of, when a Case they take part in (as Assignee, Case Role holder or Guest) is raised to Critical, and when a Task they own falls overdue (once per due date; the worker checks). Nobody is notified of their own action, nor about a Case or item they can't see; the access policy is asked again whenever notifications are read, so ones about Cases or items since hidden from their recipient drop out. Each recipient marks theirs read (`/api/notifications`). A new notification signals its recipient's sockets, and the SPA's bell refetches and toasts it. Emails are queued in the same row in the transaction that made the change, sent once it commits, and retried by the worker (up to 5 times).

Teams channel (`apps/api/src/teams/`): an Admin sets the Organization's Teams incoming webhook in Settings · Integrations (`PUT /api/teams-channel`; a legacy connector URL on `*.webhook.office.com` or a Teams Workflows URL on `*.logic.azure.com` or `*.api.powerplatform.com`, HTTPS only), can send a test post to it, and can remove it; each change is recorded in the Organization Audit Log. The URL is sealed at rest like Integration credentials and never sent back; Admins see its host and last four characters. While it is set, a new Critical Case, a Case whose Severity is raised to Critical, and a Case opened from Alerts (at any Severity, with how many) are posted to the channel as an Adaptive Card linking to the Case. Posts are queued in `teams_posts` in the transaction that made the change, sent once it commits, and retried by the worker with backoff (30 s doubling, up to 5 attempts); they go to whichever webhook is set when sent, and are dropped if it is removed. Each is written from the Case as it is when sent: a Restricted Case's post says only what happened, with a link to the Case and none of its details.

Tests build the API in-process (`apps/api/src/test/harness.ts`) with a fresh database cloned from a migrated template, a fake clock, a captured mail outbox, captured Teams posts (`t.teams.posts`, `t.teams.failNext(n)`) and in-memory Evidence storage (`t.evidenceObjects`), and drive it over HTTP with the Hono RPC client and the Better Auth client. `t.acceptInvite(email, password, name)` accepts the latest invite sent to `email` and gives a fully signed-in, TOTP-enrolled Member; `t.totpCode(secret)` plays the authenticator app. `t.connect(member)` opens that Member's live socket and collects what it receives; `t.anotherInstance()` starts a second server process on the same database. `fakeFalcon()` (`apps/api/src/test/fake-falcon.ts`) is a Falcon tenant's Event Stream that tests emit events into, drop and age out, for workers made with `createStreamWorker(t.deps, { connect: falcon.connect, workerId })` and driven by `worker.tick()`; `createNotificationWorker(t.deps).tick()` finds overdue Tasks and sends any notification emails still queued; `createTeamsSender(t.deps).tick()` sends Teams posts that are due. Its tenants also record each Alerts API patch (`tenant.patches`), hold Falcon users by email (`tenant.users`) and can fail writes (`failNextWrites`, `refuseWrites`), for write-back senders made with `createWriteBackSender(t.deps, { connect: falcon.connect })`.

## Generated code

- Better Auth schema: `bun --cwd apps/api auth:generate` (Better Auth CLI), then `bun --cwd apps/api db:generate` for the migration. Never hand-edit `apps/api/src/db/auth-schema.ts`.
- shadcn/ui components: `bunx shadcn@latest add <component>` in `apps/web`. Never copy them by hand.

## Production

`docker build .` produces one image that serves the API and the SPA (`bun apps/api/src/server.ts`), applying migrations on start. Run the same image as `bun apps/api/src/worker.ts` for the `worker` role; `WORKER_ID` names it (default host and pid).
