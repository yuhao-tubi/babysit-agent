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
