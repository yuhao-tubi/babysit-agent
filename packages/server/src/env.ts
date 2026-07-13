/**
 * Side-effect import: load the workspace-root `.env` into `process.env` before
 * anything reads it. MUST be the first import in every entrypoint (index.ts,
 * cli.ts) so KeySmith credentials are present when keysmith.ts signs requests.
 *
 * Resolved from this file's location (not cwd) so it works regardless of where
 * the daemon is launched from.
 */
import { config as loadDotenv } from "dotenv";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// env.ts lives at packages/server/src/env.ts → workspace root is three up.
// Containerized runs bind-mount the .env into a data dir and point
// BABYSIT_ENV_FILE at it; otherwise fall back to the workspace-root .env.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const envPath = process.env.BABYSIT_ENV_FILE || join(root, ".env");
loadDotenv({ path: envPath });
