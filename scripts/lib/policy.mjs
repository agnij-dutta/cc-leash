// Policy loading and merging.
//
//   defaults  <-  ~/.claude/leash.json (global)  <-  <project>/.leash.json
//
// Security model: a project file lives in a repo, and a cloned repo is not
// necessarily trusted. So by default a project policy can only TIGHTEN the
// global one (lower caps, more denied payees, stricter fallbacks). The global
// file can opt in to "projectCanLoosen": true to let projects override freely.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RULES } from "./rules.mjs";

export const CAP_KEYS = ["perCall", "perSession", "daily", "confirmAbove"];
const STRICTNESS = { allow: 0, ask: 1, deny: 2 };

export const DEFAULT_POLICY = {
  enabled: true,
  dryRun: false,
  // What to do when a payment tool is called but the amount can't be read.
  unknownAmount: "ask",
  // ...when the currency can't be read.
  unknownCurrency: "ask",
  // ...when the currency has no entry in `limits` (and there is no "*" entry).
  unlistedCurrency: "ask",
  // Caps are per currency (after aliasing). "*" is an optional catch-all.
  limits: {
    USD: { perCall: 50, perSession: 100, daily: 200, confirmAbove: 20 },
  },
  // Stablecoins count against the USD caps.
  aliases: { USDC: "USD", USDT: "USD", PYUSD: "USD", DAI: "USD", USDS: "USD" },
  // Glob patterns, case-insensitive. Empty allow list = any payee not denied.
  payees: { allow: [], deny: [] },
  // An allowed call reserves its amount until PostToolUse settles it. If the
  // call never completes (user rejected it, session crashed) the hold expires.
  reservationTtlMinutes: 15,
  // true = an in-policy call is auto-approved (skips the normal permission
  // prompt). false = leash only blocks; normal permissions still apply.
  autoApprove: false,
  // Ask before Claude edits leash config / ledger or runs `leash set`.
  guardConfig: true,
  projectCanLoosen: false,
  disableDefaultRules: false,
  // Extra tool rules (same shape as DEFAULT_RULES). Tried before the defaults.
  rules: [],
  // Tool-name regexes that are never treated as payments (false positives).
  ignore: [],
};

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function globalPolicyPath() {
  return process.env.LEASH_GLOBAL_CONFIG || path.join(claudeHome(), "leash.json");
}

export function projectDir(cwd) {
  return process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
}

export function projectPolicyPath(cwd) {
  return path.join(projectDir(cwd), ".leash.json");
}

function readJson(file, notes) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    if (!txt.trim()) return null;
    const v = JSON.parse(txt);
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      notes.push(`${file}: not a JSON object, ignored`);
      return null;
    }
    return v;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    notes.push(`${file}: ${e.message}`);
    // A corrupt policy file must not silently disable the leash: the caller
    // sees `broken` and falls back to defaults plus an ask.
    return { __broken: true };
  }
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

function stricter(a, b) {
  return (STRICTNESS[b] ?? -1) > (STRICTNESS[a] ?? -1) ? b : a;
}

function globToRe(glob) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

export function payeeMatches(patterns, payee) {
  if (!payee) return false;
  return (patterns || []).some((p) => globToRe(p).test(payee));
}

// Project policy that can only make things stricter.
function tightenMerge(base, proj, notes) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(proj)) {
    switch (k) {
      case "limits": {
        if (!isObj(v)) break;
        for (const [cur, caps] of Object.entries(v)) {
          if (!isObj(caps)) continue;
          if (!out.limits[cur] && out.limits["*"]) out.limits[cur] = { ...out.limits["*"] };
          const target = out.limits[cur];
          if (!target) {
            notes.push(`project limits.${cur} ignored: global policy has no ${cur} limits to tighten (set projectCanLoosen to allow)`);
            continue;
          }
          for (const ck of CAP_KEYS) {
            if (typeof caps[ck] !== "number") continue;
            target[ck] = typeof target[ck] === "number" ? Math.min(target[ck], caps[ck]) : caps[ck];
          }
        }
        break;
      }
      case "payees": {
        if (!isObj(v)) break;
        if (Array.isArray(v.deny)) out.payees.deny = [...new Set([...out.payees.deny, ...v.deny])];
        if (Array.isArray(v.allow) && v.allow.length) {
          out.payees.allow = out.payees.allow.length
            ? v.allow.filter((p) => payeeMatches(out.payees.allow, p))
            : [...v.allow];
          if (!out.payees.allow.length) out.payees.allow = ["__leash_nobody__"];
        }
        break;
      }
      case "unknownAmount":
      case "unknownCurrency":
      case "unlistedCurrency":
        out[k] = stricter(out[k], v);
        break;
      case "guardConfig":
        out.guardConfig = out.guardConfig || v === true;
        break;
      case "autoApprove":
        if (v === false) out.autoApprove = false;
        else if (v !== out.autoApprove) notes.push("project autoApprove ignored (can only be turned off from a project)");
        break;
      case "reservationTtlMinutes":
        if (typeof v === "number") out.reservationTtlMinutes = Math.max(out.reservationTtlMinutes, v);
        break;
      case "rules":
        // Project rules can add coverage for new tools but cannot pre-empt
        // the built-in extractors, so they go last.
        if (Array.isArray(v)) out._projectRules = v;
        break;
      case "$schema":
      case "description":
        break;
      default:
        notes.push(`project ${k} ignored (only the global policy can set it, or enable projectCanLoosen)`);
    }
  }
  return out;
}

function normalize(p) {
  const out = deepMerge(DEFAULT_POLICY, {});
  Object.assign(out, p);
  out.limits = isObj(p.limits) ? p.limits : {};
  out.payees = { allow: Array.isArray(p.payees?.allow) ? p.payees.allow : [], deny: Array.isArray(p.payees?.deny) ? p.payees.deny : [] };
  out.aliases = isObj(p.aliases) ? p.aliases : {};
  out.rules = Array.isArray(p.rules) ? p.rules : [];
  out.ignore = Array.isArray(p.ignore) ? p.ignore : [];
  return out;
}

export function loadPolicy(cwd) {
  const notes = [];
  const gPath = globalPolicyPath();
  const pPath = projectPolicyPath(cwd);
  const g = readJson(gPath, notes);
  const p = readJson(pPath, notes);
  const broken = Boolean(g?.__broken || p?.__broken);

  // Global deep-merges over the defaults, so `set limits.USD.daily 500` keeps
  // the default USD per-call cap. Set a cap to null to remove it.
  let merged = deepMerge(DEFAULT_POLICY, {});
  if (g && !g.__broken) merged = deepMerge(merged, g);
  merged = normalize(merged);

  if (p && !p.__broken) {
    if (merged.projectCanLoosen) {
      const rules = [...(Array.isArray(p.rules) ? p.rules : []), ...merged.rules];
      merged = normalize(deepMerge(merged, p));
      if (isObj(p.limits)) merged.limits = deepMerge(merged.limits, p.limits);
      merged.rules = rules;
    } else {
      merged = tightenMerge(merged, p, notes);
    }
  }

  const ruleList = [
    ...merged.rules,
    ...(merged.disableDefaultRules ? [] : DEFAULT_RULES),
    ...(merged._projectRules || []),
  ];
  delete merged._projectRules;

  return {
    policy: merged,
    rules: ruleList,
    sources: { global: g && !g.__broken ? gPath : null, project: p && !p.__broken ? pPath : null },
    paths: { global: gPath, project: pPath },
    notes,
    broken,
  };
}

export function resolveCurrency(policy, cur) {
  if (!cur) return null;
  const a = policy.aliases?.[cur];
  return a ? String(a).toUpperCase() : cur;
}

export function limitsFor(policy, cur) {
  return policy.limits?.[cur] || policy.limits?.["*"] || null;
}
