import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const exec = promisify(execFile);

export interface GateResult {
  ran: boolean; // false => no applicable check found
  passed: boolean;
  detail: string;
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
    return { ok: false, out: String(err?.stdout ?? "" + (err?.stderr ?? err?.message ?? err)).slice(-4000) };
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
export async function runGate(dir: string, repo: string): Promise<GateResult> {
  // 1. JS/TS repos: prefer test, then lint, via package.json scripts.
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const scripts = pkg.scripts ?? {};
    const hasYarn = existsSync(join(dir, "yarn.lock"));
    const runner = hasYarn ? "yarn" : "npm";
    for (const script of ["typecheck", "lint", "test"]) {
      if (scripts[script]) {
        const args = hasYarn ? [script] : ["run", script, "--if-present"];
        const r = await run(runner, args, dir);
        return {
          ran: true,
          passed: r.ok,
          detail: `${runner} ${script}: ${r.ok ? "passed" : "FAILED"}\n${r.out}`,
        };
      }
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
