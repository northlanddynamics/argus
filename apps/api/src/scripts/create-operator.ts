// Usage: bun run operator:create <email> <name>   (password read from OPERATOR_PASSWORD)
import { OPERATOR_ROLE } from "../auth/roles";
import { depsFromEnv } from "../config";
import { runMigrations } from "../db/migrate";

const [email, name] = process.argv.slice(2);
const password = process.env.OPERATOR_PASSWORD;
if (!email || !name || !password) {
  console.error("Usage: OPERATOR_PASSWORD=... bun run operator:create <email> <name>");
  process.exit(1);
}
const deps = depsFromEnv();
await runMigrations(deps.db);
await deps.auth.api.createUser({ body: { email, password, name, role: OPERATOR_ROLE } });
console.log(`Operator ${email} created`);
await deps.close();
