# Argus

Collaborative security case management for in-house teams. Vocabulary: `GLOSSARY.md`. Decisions: `docs/adr/`.

## Layout

- `apps/api`: Hono API on Bun, Better Auth at `/api/auth/*`, Postgres via Drizzle. In production it also serves the built SPA.
  - `src/crowdstrike/`: the Falcon API adapter and the `worker` process's Event Streams ingest (ADR 0002).
  - `src/routes/`: HTTP only: validate, call a module, map its errors to status codes.
  - `src/cases/`, `src/tasks/`, `src/case-roles/`, `src/discussion/`, `src/timeline/`, `src/evidence/`, `src/observables/`, `src/case-links/`, `src/tags/`, `src/alerts/`, `src/integrations/`, `src/members/`, `src/invitations/`, `src/organizations/`: one module per area of the domain, built in `src/modules.ts`; the only code that touches the database (ADR 0006).
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

CrowdStrike (ADR 0002): Admins add an Integration with Falcon API credentials (an API client with Event Streams read access), sealed at rest with AES-256-GCM under `CREDENTIALS_SECRET` (default `BETTER_AUTH_SECRET`). The `worker` process (`apps/api/src/worker.ts`, same image) claims each Integration's stream with a Postgres advisory lock, so exactly one worker reads it however many run; another takes over when it stops. It turns `EppDetectionSummaryEvent`, `IdpDetectionSummaryEvent` and `MobileDetectionSummaryEvent` into Alerts keyed by `CompositeId`, stores each event's offset with its result and resumes after it on reconnect, refreshes the stream session before Falcon's 30-minute expiry, and records a gap Falcon can no longer replay in the Organization Audit Log without backfilling it.

Live updates (ADR 0005): each signed-in tab holds one WebSocket at `/api/live` (`apps/api/src/realtime/`). Changes publish a signal with `pg_notify` in the same transaction; every process listens and forwards it only to sockets whose Member can see the Case, and the SPA (`apps/web/src/lib/live.ts`) invalidates the matching queries. Presence is kept in `case_viewers`, refreshed by each process's heartbeat.

Tests build the API in-process (`apps/api/src/test/harness.ts`) with a fresh database cloned from a migrated template, a fake clock, a captured mail outbox and in-memory Evidence storage (`t.evidenceObjects`), and drive it over HTTP with the Hono RPC client and the Better Auth client. `t.acceptInvite(email, password, name)` accepts the latest invite sent to `email` and gives a fully signed-in, TOTP-enrolled Member; `t.totpCode(secret)` plays the authenticator app. `t.connect(member)` opens that Member's live socket and collects what it receives; `t.anotherInstance()` starts a second server process on the same database. `fakeFalcon()` (`apps/api/src/test/fake-falcon.ts`) is a Falcon tenant's Event Stream that tests emit events into, drop and age out, for workers made with `createStreamWorker(t.deps, { connect: falcon.connect, workerId })` and driven by `worker.tick()`.

## Generated code

- Better Auth schema: `bun --cwd apps/api auth:generate` (Better Auth CLI), then `bun --cwd apps/api db:generate` for the migration. Never hand-edit `apps/api/src/db/auth-schema.ts`.
- shadcn/ui components: `bunx shadcn@latest add <component>` in `apps/web`. Never copy them by hand.

## Production

`docker build .` produces one image that serves the API and the SPA (`bun apps/api/src/server.ts`), applying migrations on start. Run the same image as `bun apps/api/src/worker.ts` for the `worker` role; `WORKER_ID` names it (default host and pid).
