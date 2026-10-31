import { afterEach } from "bun:test";
import { cleanUpTestApps } from "./harness";

// Preloaded (bunfig.toml) so the hook applies to every test file, not only the first to import the harness.
afterEach(cleanUpTestApps);
