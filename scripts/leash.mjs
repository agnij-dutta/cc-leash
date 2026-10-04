#!/usr/bin/env node
// cc-leash: spending limits for Claude Code.
//
// Hook entry points (stdin = hook input JSON, stdout = hook output JSON):
//   leash.mjs pre            PreToolUse
//   leash.mjs post           PostToolUse
//   leash.mjs post-failure   PostToolUseFailure
//
// Human commands (used by /leash:status, /leash:ledger, /leash:set):
//   leash.mjs status [--json]
//   leash.mjs ledger [N] [--json]
//   leash.mjs policy [--json]
//   leash.mjs set <dotted.key> <value> [--project]
//   leash.mjs add|remove <dotted.list.key> <value> [--project]
//   leash.mjs check <tool_name> '<tool_input json>'   (simulate, writes nothing)
//
// Zero dependencies. Node >= 18.

import fs from "node:fs";
import path from "node:path";
import { handlePre, handlePost, fmt, shortTool } from "./lib/engine.mjs";
import { loadPolicy, globalPolicyPath, projectPolicyPath, limitsFor, resolveCurrency, validatePolicy } from "./lib/policy.mjs";
import { compileRules, matchRule, extract } from "./lib/rules.mjs";
import * as ledger from "./lib/ledger.mjs";

const [, , cmd, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function emit(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj) + "\n");
}

// A crashing hook exits non-zero, which Claude Code treats as a non-blocking
// error: the payment would go through. So on any internal error in PreToolUse
// we escalate to the user instead. (hooks/hooks.json adds a shell fallback
// for the case where node itself cannot start.)
function failClosed(err, input) {
  const tool = input?.tool_name || "";
  if (tool && !tool.startsWith("mcp__")) return; // guard path: never wedge Bash/Edit
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: `leash hit an internal error and cannot verify this call is within your spending limits (${err && err.message}). Approve only if you expected it.`,
    },
  });
}

function runHook(kind) {
  const raw = readStdin();
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    if (kind === "pre") failClosed(e, null);
    return;
  }
  try {
    if (kind === "pre") emit(handlePre(input));
    else emit(handlePost(input, { failed: kind === "post-failure" }));
  } catch (e) {
    if (kind === "pre") {
      failClosed(e, input);
    } else {
      // The call already ran; we can't block it. Exit non-zero so the user
      // sees a hook error: an unsettled hold only counts until it expires.
      process.stderr.write(`leash: could not record this call in the ledger: ${e.stack || e}\n`);
      process.exitCode = 1;
    }
  }
}

// ------------------------------------------------------------- status

function bar(frac, width = 20) {
  const f = Math.max(0, Math.min(1, frac));
  const n = Math.round(f * width);
  return "#".repeat(n) + ".".repeat(width - n);
}

function hhmm(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

function decisionRows(entries, n) {
  return entries.filter((e) => e.event === "decision" || e.event === "settle" || (e.event === "release" && e.reason === "TOOL_FAILED")).slice(-n);
}

function rowText(e) {
  const label =
    e.event === "settle"
      ? "PAID"
      : e.event === "release"
        ? "FAILED"
        : e.decision === "dry-run"
          ? `DRY:${String(e.would).toUpperCase()}`
          : String(e.decision).toUpperCase();
  const amt = fmt(e.amount, e.currency);
  const why = e.event === "decision" && e.decision !== "allow" ? `  ${e.reason || ""}` : "";
  return `  ${hhmm(e.ts)}  ${label.padEnd(9)} ${amt.padStart(12)}  -> ${String(e.payee || "?")
    .slice(0, 24)
    .padEnd(24)} ${shortTool(e.tool)}${why}`;
}

function status() {
  const loaded = loadPolicy(process.cwd());
  const { policy } = loaded;
  const entries = ledger.readAll();
  const ttlMs = (policy.reservationTtlMinutes || 15) * 60_000;
  const { byCur, unpriced } = ledger.rollup(entries, { ttlMs });
  const lastSession = [...entries].reverse().find((e) => e.session)?.session || null;

  if (flags.has("--json")) {
    emit({ policy, sources: loaded.sources, notes: loaded.notes, today: byCur, unpriced, lastSession, recent: decisionRows(entries, 10) });
    return;
  }
  const out = [];
  const mode = !policy.enabled ? "DISABLED" : policy.dryRun ? "dry-run (logging only, nothing blocked)" : "enforcing";
  out.push(`leash: ${mode}`);
  out.push(`  global policy:  ${loaded.sources.global || `(none, defaults) ${loaded.paths.global}`}`);
  out.push(`  project policy: ${loaded.sources.project || "(none)"}`);
  out.push(`  ledger:         ${ledger.ledgerPath()}`);
  for (const n of loaded.notes) out.push(`  note: ${n}`);
  out.push("");
  out.push(`Today (${ledger.localDay()})`);
  const curs = new Set([...Object.keys(policy.limits).filter((c) => c !== "*"), ...Object.keys(byCur)]);
  if (!curs.size) out.push("  no limits configured");
  for (const cur of curs) {
    const lim = limitsFor(policy, cur) || {};
    const s = byCur[cur] || { day: 0, pending: 0, calls: 0, sessions: {} };
    const daily = typeof lim.daily === "number" ? lim.daily : null;
    out.push(
      `  ${cur.padEnd(5)} ${fmt(s.day, cur).padStart(11)} of ${daily != null ? fmt(daily, cur) : "no daily cap"}  [${bar(daily ? s.day / daily : 0)}]  ${s.calls} call(s)${s.pending ? `, ${fmt(s.pending, cur)} pending` : ""}`,
    );
    const capBits = [];
    if (lim.perCall != null) capBits.push(`per-call ${fmt(lim.perCall, cur)}`);
    if (lim.perSession != null) capBits.push(`per-session ${fmt(lim.perSession, cur)}`);
    if (lim.confirmAbove != null) capBits.push(`ask above ${fmt(lim.confirmAbove, cur)}`);
    if (capBits.length) out.push(`        caps: ${capBits.join(" · ")}`);
    if (lastSession && s.sessions[lastSession] != null) out.push(`        latest session ${lastSession.slice(0, 8)}: ${fmt(s.sessions[lastSession], cur)}`);
  }
  if (unpriced) out.push(`  ${unpriced} approved call(s) today with an unknown amount (not counted against caps)`);
  out.push("");
  const projectAllow = policy.payees.projectAllow?.length ? ` and (project) ${policy.payees.projectAllow.join(", ")}` : "";
  out.push(
    `Payees: allow ${policy.payees.allow.length ? policy.payees.allow.join(", ") : "(any)"}${projectAllow}; deny ${policy.payees.deny.length ? policy.payees.deny.join(", ") : "(none)"}`,
  );
  out.push(`Unknown amount -> ${policy.unknownAmount} · unknown currency -> ${policy.unknownCurrency} · unlisted currency -> ${policy.unlistedCurrency}`);
  out.push("");
  const recent = decisionRows(entries, 10);
  out.push("Recent");
  if (!recent.length) out.push("  (nothing yet)");
  for (const e of recent) out.push(rowText(e));
  console.log(out.join("\n"));
}

function showLedger() {
  const n = Number(args[0]) > 0 ? Number(args[0]) : 25;
  const entries = ledger.readAll();
  if (flags.has("--json") || flags.has("--raw")) {
    for (const e of entries.slice(-n)) console.log(JSON.stringify(e));
    return;
  }
  console.log(`ledger: ${ledger.ledgerPath()} (${entries.length} events, showing decisions and payments)`);
  const rows = decisionRows(entries, n);
  if (!rows.length) console.log("  (empty)");
  for (const e of rows) console.log(rowText(e));
}

function showPolicy() {
  const loaded = loadPolicy(process.cwd());
  if (flags.has("--json")) return emit({ ...loaded, rules: loaded.rules.map((r) => r.id || r.match) });
  console.log(`global:  ${loaded.paths.global}${loaded.sources.global ? "" : " (not present, using defaults)"}`);
  console.log(`project: ${loaded.paths.project}${loaded.sources.project ? "" : " (not present)"}`);
  for (const n of loaded.notes) console.log(`note: ${n}`);
  const { policy } = loaded;
  console.log(JSON.stringify({ ...policy, rules: undefined }, null, 2));
  console.log(`rules (first match wins): ${loaded.rules.map((r) => r.id || r.match).join(", ")}`);
}

// --------------------------------------------------------------- edits

// CLI values are JSON when they parse as JSON (500, true, null, ["a"]), else strings.
function parseValue(v) {
  if (v === undefined) throw new Error("missing value");
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function editFile(mutator) {
  const file = flags.has("--project") ? projectPolicyPath(process.cwd()) : globalPolicyPath();
  let obj = {};
  try {
    obj = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`${file} is not valid JSON; fix it by hand first (${e.message})`);
  }
  mutator(obj);
  // Refuse to write a policy the hook would then treat as broken.
  const { errors } = validatePolicy(obj);
  if (errors.length) throw new Error(`not saved, the result would be invalid:\n  ${errors.join("\n  ")}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
  console.log(`updated ${file}`);
  if (flags.has("--project") && !loadPolicy(process.cwd()).policy.projectCanLoosen) {
    console.log("note: project policy can only tighten the global one (projectCanLoosen is false).");
  }
}

// Resolve "limits.USD.daily" to [parentObject, "daily"], creating objects on the way.
function walk(obj, key) {
  const parts = key.split(".");
  if (parts.some((p) => !p || p === "__proto__" || p === "constructor" || p === "prototype")) throw new Error(`invalid key "${key}"`);
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== "object" || cur[p] === null || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  return [cur, parts.at(-1)];
}

// `set key null` stores null, which removes that cap (it overrides the
// default). `set key unset` deletes the key, so the default applies again.
function setCmd() {
  const [key, value] = args;
  if (!key || value === undefined) throw new Error("usage: set <dotted.key> <value|null|unset> [--project]");
  editFile((obj) => {
    const [parent, leaf] = walk(obj, key);
    if (value === "unset") delete parent[leaf];
    else parent[leaf] = parseValue(value);
  });
}

function listCmd(op) {
  const [key, value] = args;
  if (!key || value === undefined) throw new Error(`usage: ${op} <dotted.list.key> <value> [--project]`);
  editFile((obj) => {
    const [parent, leaf] = walk(obj, key);
    const list = Array.isArray(parent[leaf]) ? parent[leaf] : [];
    const v = parseValue(value);
    parent[leaf] =
      op === "add" ? [...list.filter((x) => JSON.stringify(x) !== JSON.stringify(v)), v] : list.filter((x) => JSON.stringify(x) !== JSON.stringify(v));
  });
}

// Simulate a call without touching the ledger.
function check() {
  const [tool, json] = args;
  if (!tool) throw new Error("usage: check <tool_name> '<tool_input json>'");
  let input = {};
  try {
    if (json) input = JSON.parse(json);
  } catch (e) {
    throw new Error(`tool input must be JSON, e.g. '{"amount": 5, "to": "acme"}' (${e.message})`);
  }
  const loaded = loadPolicy(process.cwd());
  const rule = matchRule(compileRules(loaded.rules), tool, loaded.policy.ignore);
  if (!rule) return console.log(`${tool}: not a payment tool (no rule matched); leash does nothing.`);
  const ex = extract(rule, input);
  const cur = resolveCurrency(loaded.policy, ex.currency);
  console.log(
    JSON.stringify({ tool, rule: rule.id, amount: ex.amount, currency: cur, rawCurrency: ex.currency, payee: ex.payee, amountPath: ex.amountPath }, null, 2),
  );
}

const HELP = `cc-leash: spending limits for Claude Code
  status [--json]                 spend today vs caps, recent decisions
  ledger [N] [--json]             last N ledger rows
  policy [--json]                 effective merged policy
  set <key> <value> [--project]   e.g. set limits.USD.daily 500
                                  value null removes a cap, unset restores the default
  add|remove <key> <value>        e.g. add payees.deny "*@scam.example"
  check <tool> '<json>'           show what leash extracts (no side effects)
hook entry points: pre | post | post-failure (stdin JSON)`;

try {
  switch (cmd) {
    case "pre":
    case "post":
    case "post-failure":
      runHook(cmd);
      break;
    case "status":
      status();
      break;
    case "ledger":
      showLedger();
      break;
    case "policy":
      showPolicy();
      break;
    case "set":
      setCmd();
      break;
    case "add":
    case "remove":
      listCmd(cmd);
      break;
    case "check":
      check();
      break;
    default:
      console.log(HELP);
  }
} catch (e) {
  console.error(`leash: ${e.message}`);
  process.exitCode = 1;
}
