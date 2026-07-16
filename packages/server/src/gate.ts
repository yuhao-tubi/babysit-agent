import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CiClass } from "./types.js";

const exec = promisify(execFile);

export interface GateResult {
  ran: boolean; // false => no applicable check found
  passed: boolean;
  detail: string;
}

/** Extra gate context for a CI fix (decision Q9/Q22). */
export interface GateOpts {
  /** Gate class of the failing CI check — selects which script(s) must pass. */
  ciClass?: CiClass;
  /** For unit-test fixes: the specific test the agent wants verified. */
  testTarget?: { file: string; nameFilter?: string };
  /**
   * Light mode: verify the DIFF, not the whole repo. Used by the apply/
   * instruction path (owner-reviewed proposals), where a full monorepo build +
   * whole-tree typecheck/lint is disproportionate to a small change. Runs an
   * incremental app typecheck (relying on build artifacts seeded from the base
   * clone) and lints only `changedFiles`. Not for CI-failure fixes — those keep
   * the full gate so the failing check is genuinely re-run.
   */
  light?: boolean;
  /** Repo-relative paths the proposal touched — scopes lint in light mode. */
  changedFiles?: string[];
}

async function run(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    return { ok: true, out: (stdout + stderr).slice(-4000) };
  } catch (err: any) {
    // Include BOTH streams: tsc/eslint write diagnostics to stdout AND stderr,
    // and which one carries the real errors varies by tool. (An earlier version
    // read `err?.stdout ?? "" + err?.stderr` — `+` binds tighter than `??`, so a
    // non-empty stdout silently dropped stderr, hiding the actual failures.)
    const out = `${err?.stdout ?? ""}${err?.stderr ?? ""}`.trim() || String(err?.message ?? err);
    return { ok: false, out: out.slice(-4000) };
  }
}

function which(cmd: string): boolean {
  // PATH lookup without throwing.
  const paths = (process.env.PATH ?? "").split(":");
  return paths.some((p) => p && existsSync(join(p, cmd)));
}

/**
 * Pre-push gate (plan decision #8). Detect and run the repo's check; if none
 * applies, return ran=false so the caller escalates ("can't self-verify").
 */
export async function runGate(dir: string, repo: string, opts: GateOpts = {}): Promise<GateResult> {
  // 1. JS/TS repos: typecheck AND lint must both pass (conjunction), as the
  //    floor. For a CI fix, the failing check's class adds the script that
  //    genuinely verifies it (build / unit test) — decision Q9b/Q22.
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const scripts = pkg.scripts ?? {};
    const hasYarn = existsSync(join(dir, "yarn.lock"));
    const runner = hasYarn ? "yarn" : "npm";

    // Light mode (apply/instruction proposals): verify the diff, not the repo.
    if (opts.light) {
      const light = await runLightGate(dir, scripts, hasYarn, runner, opts.changedFiles ?? []);
      if (light.ran) return light;
      // Fall through to the full gate if we couldn't scope a light check.
    }

    const required = ["typecheck", "lint"].filter((s) => scripts[s]);

    // build-class CI fix: the build script must also pass.
    if (opts.ciClass === "build") {
      const buildScript = ["build"].find((s) => scripts[s]);
      if (!buildScript) {
        return { ran: false, passed: false, detail: "build-class CI fix but no `build` script to self-verify" };
      }
      if (!required.includes(buildScript)) required.push(buildScript);
    }

    if (required.length) {
      const details: string[] = [];
      // Monorepo prerequisite: `typecheck-app` (tsc --noEmit) resolves the
      // workspace packages via their built `lib/*.d.ts`, but `yarn install` only
      // symlinks them — the .d.ts don't exist until each package is compiled.
      // Without this, www's typecheck floods with TS2307 "Cannot find module
      // '@adrise/*'" for every internal package. `pre-build` (lerna run build)
      // compiles them. Run it first when present; a failure fails the gate.
      if (scripts["pre-build"]) {
        const pb = await run(runner, hasYarn ? ["pre-build"] : ["run", "pre-build"], dir);
        details.push(`${runner} pre-build: ${pb.ok ? "passed" : "FAILED"}\n${pb.out}`);
        if (!pb.ok) {
          return { ran: true, passed: false, detail: details.join("\n---\n") };
        }
      }
      for (const script of required) {
        const args = hasYarn ? [script] : ["run", script];
        const r = await run(runner, args, dir);
        details.push(`${runner} ${script}: ${r.ok ? "passed" : "FAILED"}\n${r.out}`);
        if (!r.ok) {
          return { ran: true, passed: false, detail: details.join("\n---\n") };
        }
      }
      // unit-test-class CI fix: run the failing test (or whole suite as fallback).
      if (opts.ciClass === "unit_test") {
        const testGate = await runUnitTests(dir, scripts, hasYarn, runner, opts.testTarget);
        details.push(testGate.detail);
        return { ran: testGate.ran, passed: testGate.ran && testGate.passed, detail: details.join("\n---\n") };
      }
      return { ran: true, passed: true, detail: details.join("\n---\n") };
    }

    // No typecheck/lint scripts, but a unit-test CI fix still needs the suite run.
    if (opts.ciClass === "unit_test") {
      const testGate = await runUnitTests(dir, scripts, hasYarn, runner, opts.testTarget);
      return testGate;
    }
  }

  // 2. Kustomize-based repos (kustomization, argo): build all kustomizations.
  if (which("kustomize") && hasKustomizations(dir)) {
    const r = await run("bash", ["-lc", "find . -name kustomization.yaml -maxdepth 4 -execdir kustomize build . \\; >/dev/null"], dir);
    if (which("kubeconform")) {
      const k = await run("bash", ["-lc", "find . -name kustomization.yaml -maxdepth 4 -execdir sh -c 'kustomize build . | kubeconform -ignore-missing-schemas' \\;"], dir);
      return { ran: true, passed: r.ok && k.ok, detail: `kustomize build + kubeconform: ${r.ok && k.ok ? "passed" : "FAILED"}\n${r.out}\n${k.out}` };
    }
    return { ran: true, passed: r.ok, detail: `kustomize build: ${r.ok ? "passed" : "FAILED"}\n${r.out}` };
  }

  // 3. Terraform repos.
  if (which("terraform") && hasFilesWithExt(dir, ".tf")) {
    const init = await run("terraform", ["init", "-backend=false", "-input=false"], dir);
    const r = await run("terraform", ["validate", "-no-color"], dir);
    return { ran: true, passed: init.ok && r.ok, detail: `terraform validate: ${r.ok ? "passed" : "FAILED"}\n${r.out}` };
  }

  // 4. Generic YAML lint.
  if (which("yamllint") && hasFilesWithExt(dir, ".yaml", ".yml")) {
    const r = await run("yamllint", ["."], dir);
    return { ran: true, passed: r.ok, detail: `yamllint: ${r.ok ? "passed" : "FAILED"}\n${r.out}` };
  }

  return { ran: false, passed: false, detail: "no applicable check/validator found" };
}

/**
 * Light gate for owner-reviewed proposals: confirm the diff still typechecks and
 * lints, WITHOUT the whole-monorepo cost the full gate pays. Two scoped checks:
 *
 *  - Typecheck: prefer `typecheck-app` (the app's own `tsc --noEmit`) over the
 *    umbrella `typecheck` (which fans out `lerna run typecheck` across every
 *    package). It runs incrementally against the `.tsbuildinfo` + built
 *    package `lib` dirs seeded into the worktree from the base clone — so it
 *    needs no `pre-build` and re-checks only what changed. Falls to `typecheck`.
 *  - Lint: run the linter on the CHANGED FILES only, not `src bin webpack`. A
 *    reviewed proposal shouldn't be blocked by pre-existing lint elsewhere; the
 *    executor's relatedness guard already assumes gate errors map to the diff.
 *
 * `pre-build` and the `lerna run typecheck/lint` fan-outs are deliberately
 * skipped: the touched packages are already built (seeded), and unchanged
 * packages don't need re-verifying for a `src/` diff. Returns ran=false when
 * neither a typecheck nor a lint script is detectable — the caller then falls
 * back to the full gate rather than silently passing an unverified change.
 */
async function runLightGate(
  dir: string,
  scripts: Record<string, string>,
  hasYarn: boolean,
  runner: string,
  changedFiles: string[]
): Promise<GateResult> {
  const details: string[] = [];
  let ranSomething = false;

  // Monorepo cross-package staleness fix: the light gate typechecks the app
  // against sibling packages' seeded `lib/*.d.ts` (from the base clone). When
  // the diff itself changes a workspace package (e.g. adds an export to
  // `@adrise/player`), those seeded `.d.ts` are STALE — `typecheck-app` then
  // reports the PR's own new symbols as "missing" in files the diff didn't
  // touch (a false failure that escalates as inconclusive). Rebuild ONLY the
  // touched packages first (scoped, not the whole `pre-build` fan-out) so the
  // app typechecks against fresh declarations. A rebuild failure is a real,
  // in-diff signal — surface it as a gate failure.
  const rebuilt = await rebuildChangedPackages(dir, hasYarn, runner, changedFiles);
  if (rebuilt) {
    ranSomething = true;
    details.push(rebuilt.detail);
    if (!rebuilt.ok) return { ran: true, passed: false, detail: details.join("\n---\n") };
  }

  const typecheckScript = ["typecheck-app", "typecheck"].find((s) => scripts[s]);
  if (typecheckScript) {
    ranSomething = true;
    const args = hasYarn ? [typecheckScript] : ["run", typecheckScript];
    const r = await run(runner, args, dir);
    details.push(`${runner} ${typecheckScript} (light): ${r.ok ? "passed" : "FAILED"}\n${r.out}`);
    if (!r.ok) return { ran: true, passed: false, detail: details.join("\n---\n") };
  }

  // Lint only the changed JS/TS files (the linter is a no-op on other types).
  // Prefer a "base" lint script (bare `eslint` with NO baked-in paths) so the
  // changed files become the sole positionals — `lint:main`/`lint` typically
  // hardcode `src bin webpack`, where extra args APPEND rather than scope.
  const lintFiles = changedFiles.filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f));
  const lintScript = ["lint:base", "lint:main", "lint"].find((s) => scripts[s]);
  if (lintFiles.length && lintScript) {
    ranSomething = true;
    // `<runner> <script> -- <files>` forwards the paths as eslint positionals,
    // overriding the script's default `src bin webpack` scope.
    const base = hasYarn ? [lintScript] : ["run", lintScript];
    const r = await run(runner, [...base, "--", ...lintFiles], dir);
    details.push(`${runner} ${lintScript} (light, ${lintFiles.length} file(s)): ${r.ok ? "passed" : "FAILED"}\n${r.out}`);
    if (!r.ok) return { ran: true, passed: false, detail: details.join("\n---\n") };
  }

  return { ran: ranSomething, passed: ranSomething, detail: details.join("\n---\n") };
}

/**
 * Rebuild the workspace packages the diff touched, scoped via `lerna run build
 * --scope`. Maps each changed `packages/<dir>/…` path to that package's declared
 * `name` (the lerna scope — a dir like `player` is package `@adrise/player`),
 * keeps only packages that have their own `build` script, and rebuilds just
 * those. Deliberately NOT the whole `pre-build` (`rm -rf build && lerna run
 * build` over every package): that is the slow, all-packages fan-out we're
 * avoiding. Returns null when the diff touches no buildable workspace package
 * (nothing to rebuild — the app-only common case), so the caller skips it.
 */
async function rebuildChangedPackages(
  dir: string,
  hasYarn: boolean,
  runner: string,
  changedFiles: string[]
): Promise<{ ok: boolean; detail: string } | null> {
  // Collect the distinct `packages/<dir>` roots the diff touched.
  const pkgDirs = new Set<string>();
  for (const f of changedFiles) {
    const m = /^packages\/([^/]+)\//.exec(f);
    if (m) pkgDirs.add(m[1]);
  }
  if (!pkgDirs.size) return null;

  // Resolve each dir to its package name, keeping only ones with a build script.
  const scopes: string[] = [];
  for (const d of pkgDirs) {
    const pkgJson = join(dir, "packages", d, "package.json");
    if (!existsSync(pkgJson)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      if (pkg?.name && pkg?.scripts?.build) scopes.push(pkg.name);
    } catch {
      // Unreadable package.json — skip; the whole-app typecheck still runs.
    }
  }
  if (!scopes.length) return null;

  // `lerna run build --scope <a> --scope <b>` filters to exactly those packages.
  const lernaArgs = ["build"];
  for (const s of scopes) lernaArgs.push("--scope", s);
  const args = hasYarn ? ["lerna", "run", ...lernaArgs] : ["exec", "lerna", "run", ...lernaArgs];
  const r = await run(runner, args, dir);
  return {
    ok: r.ok,
    detail: `${runner} lerna run build --scope ${scopes.join(" ")} (${scopes.length} pkg): ${r.ok ? "passed" : "FAILED"}\n${r.out}`,
  };
}

/**
 * Run the repo's unit tests for a unit-test CI fix (decision Q9b/Q9c). Prefers
 * the agent-supplied target (fast); falls back to the whole suite when there's
 * no target, the target matched nothing, or the targeted run errors out. A run
 * that matched ZERO tests never counts as a pass. Returns ran=false when no test
 * script is detectable (caller escalates).
 */
async function runUnitTests(
  dir: string,
  scripts: Record<string, string>,
  hasYarn: boolean,
  runner: string,
  target?: { file: string; nameFilter?: string }
): Promise<GateResult> {
  const testScript = ["test:unit", "test"].find((s) => scripts[s]);
  if (!testScript) {
    return { ran: false, passed: false, detail: "unit-test CI fix but no test script detected" };
  }
  const base = hasYarn ? [testScript] : ["run", testScript];

  // Targeted run first, if the agent gave us a target.
  if (target?.file) {
    const extra = ["--", target.file];
    if (target.nameFilter) extra.push("-t", target.nameFilter);
    const r = await run(runner, [...base, ...extra], dir);
    const zero = /no tests found|0 (passed|total)|matched 0 tests/i.test(r.out);
    if (zero) {
      // Target matched nothing — a bad filter; fall back to the whole suite.
    } else {
      // Target ran for real: its pass/fail IS the verdict (don't mask a real
      // failure by re-running the whole suite).
      return {
        ran: true,
        passed: r.ok,
        detail: `${runner} ${testScript} ${target.file}: ${r.ok ? "passed" : "FAILED"}\n${r.out}`,
      };
    }
  }

  const full = await run(runner, base, dir);
  const zeroFull = /no tests found|matched 0 tests/i.test(full.out);
  return {
    ran: true,
    passed: full.ok && !zeroFull,
    detail: `${runner} ${testScript} (whole suite): ${full.ok && !zeroFull ? "passed" : "FAILED"}\n${full.out}`,
  };
}

function hasKustomizations(dir: string): boolean {
  // Shallow check — the build command itself walks deeper.
  try {
    return walkFind(dir, (n) => n === "kustomization.yaml" || n === "kustomization.yml", 4);
  } catch {
    return false;
  }
}

function hasFilesWithExt(dir: string, ...exts: string[]): boolean {
  try {
    return walkFind(dir, (n) => exts.some((e) => n.endsWith(e)), 3);
  } catch {
    return false;
  }
}

function walkFind(dir: string, pred: (name: string) => boolean, depth: number): boolean {
  if (depth < 0) return false;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git" || ent.name === "node_modules") continue;
    if (ent.isFile() && pred(ent.name)) return true;
    if (ent.isDirectory() && walkFind(join(dir, ent.name), pred, depth - 1)) return true;
  }
  return false;
}
