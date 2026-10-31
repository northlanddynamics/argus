# Bun, Hono, Better Auth, Postgres and Drizzle in one monorepo

Argus is a Bun monorepo with `apps/web` (Vite + React SPA using shadcn/ui and TanStack Router) and `apps/api` (Hono on Bun, Better Auth mounted at `/api/auth/*`), sharing types through Hono RPC; in production Hono serves the built SPA. One image runs in two process roles: `web` (Hono API, SPA, WebSockets) and `worker` (long-lived CrowdStrike Event Streams connections, one per Integration, each owned by exactly one worker via a Postgres advisory lock). Data lives in Postgres via Drizzle, using Better Auth's Drizzle adapter, because collaborative multi-user editing and tenancy isolation need a real concurrent database. Live updates go over WebSockets (native in Bun).

## Consequences

- shadcn/ui components must be added only through the shadcn CLI (`bunx shadcn@latest add ...`), never copied by hand, so they stay upgradeable.
- Better Auth schema and plugins must be set up only through the Better Auth CLI (`bunx @better-auth/cli generate` / `migrate`), never hand-written.
- Evidence storage is accessed through the S3 API only, so hosting and storage provider can be chosen at deploy time.
