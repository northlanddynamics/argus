# Argus

Collaborative security case management for in-house teams. Vocabulary: `GLOSSARY.md`. Decisions: `docs/adr/`.

## Layout

- `apps/api`: Hono API on Bun, Better Auth at `/api/auth/*`, Postgres via Drizzle. In production it also serves the built SPA.
- `apps/web`: Vite + React SPA (shadcn/ui, TanStack Router, TanStack Query), typed against the API through Hono RPC (`api/client`).

## Develop

```sh
bun install
cp .env.example .env               # then edit
bun --cwd apps/api db:migrate
OPERATOR_PASSWORD=... bun --cwd apps/api operator:create ops@example.com "Ops"
bun run dev:api                    # :3000
bun run dev:web                    # :5173, proxies /api to :3000
```

## Checks

```sh
bun run lint
bun run typecheck
bun run test        # API tests against a real Postgres (TEST_DATABASE_URL, an admin connection)
bun run test:e2e    # builds the SPA, then a Playwright smoke test with the pre-installed Chromium
```

Members who sign in with a password must use TOTP: until they enroll, their session reaches only the enrollment endpoints (`apps/api/src/auth/totp-enrollment.ts`). Passkeys use `BASE_URL` as their origin and its hostname as the relying party ID, so set it to the public origin.

Tests build the API in-process (`apps/api/src/test/harness.ts`) with a fresh database cloned from a migrated template, a fake clock and a captured mail outbox, and drive it over HTTP with the Hono RPC client and the Better Auth client. `t.acceptAsOwner(...)` gives a fully signed-in, TOTP-enrolled Owner; `t.totpCode(secret)` plays the authenticator app.

## Generated code

- Better Auth schema: `bun --cwd apps/api auth:generate` (Better Auth CLI), then `bun --cwd apps/api db:generate` for the migration. Never hand-edit `apps/api/src/db/auth-schema.ts`.
- shadcn/ui components: `bunx shadcn@latest add <component>` in `apps/web`. Never copy them by hand.

## Production

`docker build .` produces one image that serves the API and the SPA (`bun apps/api/src/server.ts`), applying migrations on start.
