import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "scripts", "leash.mjs");
const FIX = path.join(ROOT, "test", "fixtures");

// A fresh sandbox per test: its own global policy, project dir and ledger,
// so nothing ever touches the real ~/.claude.
export function sandbox({ global, project } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leash-test-"));
  const proj = path.join(dir, "project");
  fs.mkdirSync(proj);
  const env = {
    ...process.env,
    HOME: dir,
    CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
    LEASH_HOME: path.join(dir, ".claude", "leash"),
    LEASH_GLOBAL_CONFIG: path.join(dir, ".claude", "leash.json"),
    CLAUDE_PROJECT_DIR: proj,
  };
  delete env.LEASH_LEDGER;
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  if (global) fs.writeFileSync(env.LEASH_GLOBAL_CONFIG, typeof global === "string" ? global : JSON.stringify(global));
  if (project) fs.writeFileSync(path.join(proj, ".leash.json"), typeof project === "string" ? project : JSON.stringify(project));
  const ledgerFile = path.join(env.LEASH_HOME, "ledger.jsonl");
  return {
    dir,
    proj,
    env,
    ledgerFile,
    ledger() {
      try {
        return fs.readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    fixture(name, patch = {}) {
      const raw = fs.readFileSync(path.join(FIX, `${name}.json`), "utf8").replace(/__CWD__/g, proj);
      const obj = JSON.parse(raw);
      return deepPatch(obj, patch);
    },
    run(kind, payload) {
      const r = spawnSync(process.execPath, [CLI, kind], {
        input: typeof payload === "string" ? payload : JSON.stringify(payload),
        env,
        encoding: "utf8",
      });
      return parse(r);
    },
    runAsync(kind, payload) {
      return new Promise((resolve) => {
        const c = spawn(process.execPath, [CLI, kind], { env });
        let stdout = "";
        let stderr = "";
        c.stdout.on("data", (d) => (stdout += d));
        c.stderr.on("data", (d) => (stderr += d));
        c.on("close", (status) => resolve(parse({ status, stdout, stderr })));
        c.stdin.end(JSON.stringify(payload));
      });
    },
    cli(...args) {
      const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", cwd: proj });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

function parse(r) {
  const out = (r.stdout || "").trim();
  let json = null;
  if (out) json = JSON.parse(out);
  return {
    status: r.status,
    stderr: r.stderr,
    json,
    decision: json?.hookSpecificOutput?.permissionDecision ?? null,
    reason: json?.hookSpecificOutput?.permissionDecisionReason ?? "",
  };
}

function deepPatch(obj, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && obj[k] && typeof obj[k] === "object" && !Array.isArray(obj[k])) deepPatch(obj[k], v);
    else obj[k] = v;
  }
  return obj;
}

let n = 0;
export const uid = (p = "toolu_t") => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;
