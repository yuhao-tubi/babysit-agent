/**
 * Where the workspace root is, resolved the same way from source and from build.
 *
 * `.env` and `config.json` live at the workspace root, and every entrypoint has
 * to find them before it can do anything. The obvious spelling — "three levels
 * up from this file" — is only correct for `packages/server/src/*.ts`. The built
 * daemon runs `packages/server/dist/*.js`, which is the same depth, so three up
 * still lands on `packages/` … but only by luck of the layout, and a hardcoded
 * hop count silently returns the WRONG directory the moment the layout moves.
 *
 * Getting it wrong is not a loud failure: `loadConfig` simply finds no
 * config.json and falls back to defaults — and the default is `dryRun: true`,
 * so a misresolved root turns the daemon into a no-op that still logs "running"
 * and polls happily while writing nothing to GitHub. That is the worst kind of
 * bug, so resolve the root by looking for the thing that actually defines it
 * (the workspaces manifest) instead of counting directories.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** True if `dir/package.json` is the monorepo root manifest (it declares workspaces). */
function isWorkspaceRoot(dir: string): boolean {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    return Array.isArray(JSON.parse(readFileSync(manifest, "utf8")).workspaces);
  } catch {
    return false; // unreadable/!JSON — not a root we can trust
  }
}

/**
 * The workspace root: walk up from this module until a package.json declaring
 * `workspaces` turns up. Correct from `src/` and from `dist/`, and from any
 * future nesting depth.
 *
 * Falls back to the historical three-up guess so a stripped deployment (no
 * manifests shipped) behaves exactly as it did before rather than throwing.
 */
export function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (isWorkspaceRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
