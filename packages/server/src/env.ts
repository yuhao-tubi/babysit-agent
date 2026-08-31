/**
 * Side-effect import: load the workspace-root `.env` into `process.env` before
 * anything reads it. MUST be the first import in every entrypoint (index.ts,
 * cli.ts) so the Bedrock TVM credentials are present when bedrock-auth.ts signs
 * its token requests.
 *
 * Resolved from this file's location (not cwd) so it works regardless of where
 * the daemon is launched from.
 */
import { config as loadDotenv } from "dotenv";
import { join } from "node:path";
import { workspaceRoot } from "./paths.js";

// Containerized runs bind-mount the .env into a data dir and point
// BABYSIT_ENV_FILE at it; otherwise fall back to the workspace-root .env.
const envPath = process.env.BABYSIT_ENV_FILE || join(workspaceRoot(), ".env");
loadDotenv({ path: envPath });
