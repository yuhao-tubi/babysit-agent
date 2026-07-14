/**
 * Interactive setup wizard for the containerized distribution.
 *
 *   tsx src/setup.ts setup    — prompt for creds/config, VALIDATE live, then
 *                               write .env + config.json into the data mount.
 *   tsx src/setup.ts doctor   — non-interactive: re-validate the existing
 *                               .env + config.json and report (CI-friendly).
 *   tsx src/setup.ts recover  — probe each base clone for corruption and PRINT
 *                               the recovery commands (never deletes anything).
 *
 * "Validate live" means we actually exercise the credentials before writing:
 *   - GH_TOKEN     → `gh api user` (confirms the token + resolves the login)
 *   - KeySmith key → mint a real Bedrock token (confirms key + model access)
 *
 * Paths follow the same env overrides the daemon honors, so the wizard writes
 * exactly where `run` will later read (see Dockerfile / entrypoint.sh):
 *   BABYSIT_ENV_FILE  (default: <workspace>/.env)
 *   BABYSIT_CONFIG    (default: <workspace>/config.json)
 */
import "./env.js"; // load any existing .env first, for sensible prompt defaults
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const exec = promisify(execFile);

/** Workspace root (packages/server/src → three up). */
function workspaceRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
function envPath(): string {
  return process.env.BABYSIT_ENV_FILE || join(workspaceRoot(), ".env");
}
function configPath(): string {
  return process.env.BABYSIT_CONFIG || join(workspaceRoot(), "config.json");
}

// ---- prompting -----------------------------------------------------------

const rl = createInterface({ input: stdin, output: stdout });

async function ask(label: string, fallback = ""): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || fallback;
}

/**
 * Prompt without echoing the typed characters (for secrets). We print the
 * label ourselves, then mute readline's echo (`_writeToOutput`) for the read.
 */
async function askSecret(label: string, fallback = ""): Promise<string> {
  const hint = fallback ? " [keep existing]" : "";
  stdout.write(`${label}${hint}: `);
  const w = rl as unknown as { _writeToOutput?: (s: string) => void };
  const original = w._writeToOutput?.bind(rl);
  w._writeToOutput = () => {}; // swallow keystroke echo
  try {
    const answer = (await rl.question("")).trim();
    return answer || fallback;
  } finally {
    w._writeToOutput = original;
    stdout.write("\n");
  }
}

// ---- validation ----------------------------------------------------------

/** Confirm the GitHub token works; return the resolved login. Throws on failure. */
async function validateGitHub(token: string): Promise<string> {
  process.env.GH_TOKEN = token;
  process.env.GITHUB_TOKEN = token;
  try {
    const { stdout } = await exec("gh", ["api", "user", "--jq", ".login"]);
    return stdout.trim();
  } catch (err) {
    throw new Error(
      `GitHub token rejected: ${(err as Error).message.split("\n")[0]}`
    );
  }
}

/**
 * Confirm the KeySmith key mints a Bedrock token for the configured model.
 * Imported lazily so its module-level config read happens AFTER we've set the
 * env vars and (in setup) written config.json.
 */
async function validateKeySmith(): Promise<string> {
  const { getBedrockSession } = await import("./keysmith.js");
  const session = await getBedrockSession();
  return session.modelArn;
}

// ---- config writing ------------------------------------------------------

function readJsonIfExists(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeEnv(vals: Record<string, string>): void {
  const path = envPath();
  mkdirSync(dirname(path), { recursive: true });
  const body =
    "# Written by `setup`. KeySmith creds for Bedrock + GitHub token.\n" +
    "# gitignored / lives in the mounted data dir — treat as secret.\n" +
    Object.entries(vals)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") +
    "\n";
  writeFileSync(path, body, { mode: 0o600 });
}

function writeConfig(patch: Record<string, unknown>): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const merged = { ...readJsonIfExists(path), ...patch };
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
}

// ---- commands ------------------------------------------------------------

async function runSetup(): Promise<void> {
  console.log("\nPR Babysitting Agent — setup\n" + "=".repeat(28) + "\n");
  console.log(
    "Enter credentials below. They are validated live before anything is written.\n"
  );

  // GitHub token first (needed to resolve the login default).
  const ghToken = await askSecret("GitHub token (GH_TOKEN, repo scope)", process.env.GH_TOKEN);
  if (!ghToken) throw new Error("GitHub token is required.");
  process.stdout.write("  → validating GitHub token… ");
  const detectedLogin = await validateGitHub(ghToken);
  console.log(`ok (login: ${detectedLogin})`);

  // KeySmith creds.
  const ksUrl = await ask("KeySmith URL", process.env.KEYSMITH_URL || "https://keysmith.int.tubi.io");
  const ksKeyId = await ask("KeySmith key id (KEYSMITH_KEY_ID)", process.env.KEYSMITH_KEY_ID);
  if (!ksKeyId) throw new Error("KEYSMITH_KEY_ID is required.");
  const ksSecret = await askSecret("KeySmith secret (KEYSMITH_SECRET)", process.env.KEYSMITH_SECRET);
  if (!ksSecret) throw new Error("KEYSMITH_SECRET is required.");

  // Config knobs.
  const githubLogin = await ask("Your GitHub login", detectedLogin);
  const allowReposRaw = await ask(
    "allowRepos (comma-separated owner/repo; blank = all authored PRs)",
    ""
  );
  const allowRepos = allowReposRaw
    ? allowReposRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  // Write .env, then config.json, THEN validate KeySmith (mint() reads both).
  writeEnv({
    GH_TOKEN: ghToken,
    GITHUB_TOKEN: ghToken,
    KEYSMITH_URL: ksUrl,
    KEYSMITH_KEY_ID: ksKeyId,
    KEYSMITH_SECRET: ksSecret,
  });
  process.env.KEYSMITH_URL = ksUrl;
  process.env.KEYSMITH_KEY_ID = ksKeyId;
  process.env.KEYSMITH_SECRET = ksSecret;

  writeConfig({ githubLogin, allowRepos });

  process.stdout.write("  → validating KeySmith (minting a Bedrock token)… ");
  const modelArn = await validateKeySmith();
  console.log(`ok\n     model → ${modelArn}`);

  console.log(`\nWrote ${envPath()}\nWrote ${configPath()}`);
  console.log(
    "\nSetup complete. Start the daemon with `run` (or `docker compose up -d`)."
  );
}

async function runDoctor(): Promise<void> {
  console.log("\nPR Babysitting Agent — doctor\n" + "=".repeat(29) + "\n");
  let ok = true;

  const cfgPath = configPath();
  const envFile = envPath();
  console.log(`config: ${cfgPath} ${existsSync(cfgPath) ? "✓" : "✗ MISSING"}`);
  console.log(`env:    ${envFile} ${existsSync(envFile) ? "✓" : "✗ MISSING"}`);

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.log("GitHub: ✗ no GH_TOKEN in env");
    ok = false;
  } else {
    try {
      const login = await validateGitHub(token);
      console.log(`GitHub: ✓ token valid (login: ${login})`);
    } catch (err) {
      console.log(`GitHub: ✗ ${(err as Error).message}`);
      ok = false;
    }
  }

  try {
    const modelArn = await validateKeySmith();
    console.log(`KeySmith: ✓ minted token (model: ${modelArn})`);
  } catch (err) {
    console.log(`KeySmith: ✗ ${(err as Error).message}`);
    ok = false;
  }

  console.log(ok ? "\nAll checks passed." : "\nOne or more checks FAILED.");
  if (!ok) throw new Error("doctor: checks failed");
}

/**
 * Probe each base clone for corruption and PRINT a recovery script — never
 * delete anything. A base clone's `.git` can be left wedged by an interrupted
 * blobless fetch (daemon killed / container OOM / disk full); `ensureBase` only
 * re-clones when `.git` is ABSENT, so a present-but-corrupt clone retries the
 * same broken repo every poll and never self-heals. The fix is to delete the
 * whole repo dir so the next poll re-clones it — but we leave that destructive
 * act to the operator and just hand them the exact commands.
 *
 * This is a symptom probe, not `git fsck`: fsck reports missing blobs on a
 * healthy blobless partial clone (that's the point of `--filter=blob:none`), so
 * it can't tell wedged from fine. Instead we run the same cheap local reads the
 * daemon relies on (`rev-parse HEAD`, `status`); if those throw, the object
 * store / index is damaged.
 */
async function runRecover(): Promise<void> {
  console.log("\nPR Babysitting Agent — recover\n" + "=".repeat(30) + "\n");

  // Lazy import so the config module's env read happens after env.js has run.
  const { loadConfig } = await import("./config.js");
  const { reposRoot } = loadConfig();

  if (!existsSync(reposRoot)) {
    console.log(`No repos dir yet (${reposRoot}); nothing to check.`);
    return;
  }

  const { readdirSync } = await import("node:fs");
  const clones = readdirSync(reposRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  if (clones.length === 0) {
    console.log(`No base clones under ${reposRoot}; nothing to check.`);
    return;
  }

  const wedged: string[] = [];
  for (const name of clones) {
    const dir = join(reposRoot, name);
    if (!existsSync(join(dir, ".git"))) {
      // No .git → ensureBase re-clones on the next poll; self-heals, not wedged.
      console.log(`  ${name}: ✓ (no .git — will re-clone on next poll)`);
      continue;
    }
    const healthy = await probeClone(dir);
    if (healthy) {
      console.log(`  ${name}: ✓ healthy`);
    } else {
      console.log(`  ${name}: ✗ WEDGED (.git present but git ops fail)`);
      wedged.push(name);
    }
  }

  if (wedged.length === 0) {
    console.log("\nAll base clones look healthy. Nothing to recover.");
    return;
  }

  // `owner__repo` on disk → `owner/repo` display path is cosmetic; the recovery
  // deletes the on-disk dir, so we print the real dir names.
  console.log(
    `\n${wedged.length} clone(s) need recovery. Run these commands on the host` +
      ` (they delete the wedged clone so the next poll re-clones + reprovisions it):\n`
  );
  console.log("  make docker-down");
  for (const name of wedged) {
    console.log(`  rm -rf .data/repos/${name}`);
  }
  console.log("  make docker-up\n");
  console.log(
    "Native (no Docker)? Stop the daemon, delete the same dirs under your" +
      " reposRoot, and restart — the next poll rebuilds them."
  );
}

/**
 * Cheap local integrity probe: resolve HEAD and read the index/worktree. These
 * are exactly the reads `ensureBase` depends on, and they need no network, so a
 * failure means a damaged object store or index — not a transient blip and not
 * a lazily-absent blob. Returns true if the clone is usable.
 */
async function probeClone(dir: string): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "HEAD"], { cwd: dir });
    await exec("git", ["status", "--porcelain"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] || "setup";
  try {
    if (cmd === "setup") await runSetup();
    else if (cmd === "doctor") await runDoctor();
    else if (cmd === "recover") await runRecover();
    else {
      console.error("usage: setup.ts <setup|doctor|recover>");
      process.exitCode = 1;
    }
  } finally {
    rl.close();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(`\n✗ ${(err as Error).message}`);
    process.exit(1);
  }
);
