# The API is split into one module per area of the domain, not service and repository layers

Routes in `apps/api/src/routes/` only validate input, call a module and turn its typed errors into status codes. Each area of the domain has one module (`cases/`, `members/`, `invitations/`, `organizations/`, built together in `src/modules.ts`) that holds its rules, its access-policy checks and its SQL. Only modules touch the database. A lint rule forbids routes from importing `drizzle-orm` or `db/`.

We did not split modules into services over repositories. A write and its audit entry (ADR 0003), and its live signal (ADR 0005), must commit in one transaction. A repository layer would mean passing that transaction through every call or adding a unit of work. Visibility is enforced in SQL (`visibleCases`), so it can't sit above a storage interface. Postgres is the only store, so a repository interface would have nothing to vary over. Tests run over HTTP against a real database and need no fakes at that seam.

Modules take the acting Member (or Operator) and plain input, never a Hono context. That way a worker, such as CrowdStrike ingestion (ADR 0002), calls the same code the API does. Routes map errors explicitly rather than through a global error handler, so the status codes stay visible to the Hono RPC client's types.
