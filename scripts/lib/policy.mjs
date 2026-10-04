// Policy loading, validation and merging.
//
//   defaults  <-  ~/.claude/leash.json (global)  <-  <project>/.leash.json
//
// Security model: a project file lives in a repo, and a cloned repo is not
// necessarily trusted. So by default a project policy can only TIGHTEN the
// global one (lower caps, more denied payees, stricter fallbacks). The global
// file can opt in to "projectCanLoosen": true to let projects override freely.
//
// Fail-closed rule: a policy file that is unreadable, not JSON, or has a value
// of the wrong type is marked `broken`. It is never half-applied (a cap written
// as "50" instead of 50 must not silently become "no cap"). The engine then
// escalates every payment to the user until the file is fixed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RULES, normCurrency } from "./rules.mjs";

/** Cap names under `limits.<CUR>`, all in major units (dollars, not cents). */
export const CAP_KEYS = ["perCall", "perSession", "daily", "confirmAbove"];

/** Allowed values for the unknownAmount / unknownCurrency / unlistedCurrency fallbacks, by strictness. */
export const STRICTNESS = { allow: 0, ask: 1, deny: 2 };

const BOOL_KEYS = ["enabled", "dryRun", "autoApprove", "guardConfig", "projectCanLoosen", "disableDefaultRules"];
const FALLBACK_KEYS = ["unknownAmount", "unknownCurrency", "unlistedCurrency"];
const KNOWN_KEYS = new Set([
  ...BOOL_KEYS,
  ...FALLBACK_KEYS,
  "limits",
  "aliases",
  "payees",
  "reservationTtlMinutes",
  "rules",
  "ignore",
  "$schema",
  "description",
]);
const RULE_KEYS = new Set(["id", "description", "match", "exclude", "amount", "currency", "payee", "scale", "minorUnits"]);
// Keys that would reach Object.prototype through a plain-object merge.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

/** Claude Code's config directory (honors CLAUDE_CONFIG_DIR). */
export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** Path of the global policy file (LEASH_GLOBAL_CONFIG, else ~/.claude/leash.json). */
export function globalPolicyPath() {
  return process.env.LEASH_GLOBAL_CONFIG || path.join(claudeHome(), "leash.json");
}

/** Project root: CLAUDE_PROJECT_DIR (set by Claude Code for hooks), else the hook's cwd. */
export function projectDir(cwd) {
  return process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
}

/** Path of the per-project policy file, `<project>/.leash.json`. */
export function projectPolicyPath(cwd) {
  return path.join(projectDir(cwd), ".leash.json");
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNonNegNumber = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

function badRegex(src) {
  try {
    new RegExp(src, "i");
    return null;
  } catch (e) {
    return e.message;
  }
}

/**
 * Check a parsed policy file. Returns `errors` (the file must not be applied)
 * and `warnings` (harmless, e.g. an unknown top-level key).
 * @param {object} obj parsed JSON
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validatePolicy(obj) {
  const errors = [];
  const warnings = [];
  if (!isObj(obj)) return { errors: ["the policy must be a JSON object"], warnings };
  for (const [key, val] of Object.entries(obj)) {
    if (UNSAFE_KEYS.has(key)) {
      errors.push(`"${key}" is not allowed as a key`);
    } else if (!KNOWN_KEYS.has(key)) {
      warnings.push(`unknown key "${key}" ignored`);
    } else if (BOOL_KEYS.includes(key)) {
      if (typeof val !== "boolean") errors.push(`${key} must be true or false, got ${JSON.stringify(val)}`);
    } else if (FALLBACK_KEYS.includes(key)) {
      if (!Object.hasOwn(STRICTNESS, val)) errors.push(`${key} must be "allow", "ask" or "deny", got ${JSON.stringify(val)}`);
    } else if (key === "reservationTtlMinutes") {
      if (!(typeof val === "number" && val > 0)) errors.push(`reservationTtlMinutes must be a positive number, got ${JSON.stringify(val)}`);
    } else if (key === "limits") {
      validateLimits(val, errors);
    } else if (key === "aliases") {
      if (!isObj(val)) errors.push('aliases must be an object like {"USDC": "USD"}');
      else
        for (const [from, to] of Object.entries(val)) if (to !== null && typeof to !== "string") errors.push(`aliases.${from} must be a currency code string`);
    } else if (key === "payees") {
      if (!isObj(val)) errors.push("payees must be an object with allow and/or deny lists");
      else
        for (const [sub, list] of Object.entries(val)) {
          if (sub !== "allow" && sub !== "deny") errors.push(`payees.${sub} is not a known list (use payees.allow or payees.deny)`);
          else if (!isStringArray(list)) errors.push(`payees.${sub} must be a list of strings`);
        }
    } else if (key === "ignore") {
      if (!isStringArray(val)) errors.push("ignore must be a list of regex strings");
      else for (const src of val) if (badRegex(src)) errors.push(`ignore entry ${JSON.stringify(src)} is not a valid regex: ${badRegex(src)}`);
    } else if (key === "rules") {
      if (!Array.isArray(val)) errors.push("rules must be a list");
      else val.forEach((rule, i) => validateRule(rule, `rules[${i}]`, errors, warnings));
    }
  }
  return { errors, warnings };
}

function validateLimits(limits, errors) {
  if (!isObj(limits)) {
    errors.push("limits must be an object keyed by currency code");
    return;
  }
  for (const [cur, caps] of Object.entries(limits)) {
    if (UNSAFE_KEYS.has(cur)) {
      errors.push(`limits.${cur} is not allowed`);
      continue;
    }
    if (caps === null) continue; // removes that currency's caps
    if (!isObj(caps)) {
      errors.push(`limits.${cur} must be an object like {"perCall": 50}`);
      continue;
    }
    for (const [cap, v] of Object.entries(caps)) {
      // An unknown cap name is an error, not a warning: "perday" would
      // otherwise leave the currency with no daily cap at all.
      if (!CAP_KEYS.includes(cap)) errors.push(`limits.${cur}.${cap} is not a known cap (use ${CAP_KEYS.join(", ")})`);
      else if (v !== null && !isNonNegNumber(v)) errors.push(`limits.${cur}.${cap} must be a number or null, got ${JSON.stringify(v)}`);
    }
  }
}

function validateRule(rule, where, errors, warnings) {
  if (!isObj(rule)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (typeof rule.match !== "string") errors.push(`${where}.match must be a regex string`);
  else if (badRegex(rule.match)) errors.push(`${where}.match is not a valid regex: ${badRegex(rule.match)}`);
  if (rule.exclude !== undefined && (typeof rule.exclude !== "string" || badRegex(rule.exclude))) errors.push(`${where}.exclude must be a valid regex string`);
  for (const k of ["amount", "currency", "payee"]) {
    if (rule[k] !== undefined && !isStringArray(rule[k])) errors.push(`${where}.${k} must be a list of path strings`);
  }
  if (rule.scale !== undefined && !(typeof rule.scale === "number" && rule.scale > 0)) errors.push(`${where}.scale must be a positive number`);
  if (rule.minorUnits !== undefined && typeof rule.minorUnits !== "boolean") errors.push(`${where}.minorUnits must be true or false`);
  for (const k of Object.keys(rule)) if (!RULE_KEYS.has(k)) warnings.push(`${where}.${k} is not a known rule key, ignored`);
}

// Currency codes are compared after normCurrency, so "usd" in a policy file
// must mean the same as "USD" in a tool call.
function canonicalize(obj) {
  const out = { ...obj };
  if (isObj(obj.limits)) out.limits = Object.fromEntries(Object.entries(obj.limits).map(([c, v]) => [c === "*" ? c : normCurrency(c), v]));
  if (isObj(obj.aliases))
    out.aliases = Object.fromEntries(Object.entries(obj.aliases).map(([from, to]) => [normCurrency(from), to === null ? null : normCurrency(to)]));
  return out;
}

const BROKEN = Object.freeze({ __broken: true });

function readPolicyFile(file, notes) {
  let txt;
  try {
    txt = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    notes.push(`${file}: cannot be read (${e.message})`);
    return BROKEN;
  }
  if (!txt.trim()) return null;
  let obj;
  try {
    obj = JSON.parse(txt);
  } catch (e) {
    notes.push(`${file}: not valid JSON (${e.message})`);
    return BROKEN;
  }
  const { errors, warnings } = validatePolicy(obj);
  for (const w of warnings) notes.push(`${file}: ${w}`);
  if (errors.length) {
    for (const err of errors) notes.push(`${file}: ${err}`);
    return BROKEN;
  }
  return canonicalize(obj);
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (isObj(v) && isObj(base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

function stricter(a, b) {
  return (STRICTNESS[b] ?? -1) > (STRICTNESS[a] ?? -1) ? b : a;
}

function globToRe(glob) {
  const esc = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

/**
 * True when `payee` matches any of the case-insensitive glob `patterns`
 * (`*` = any run of characters, `?` = one character).
 */
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
        for (const [cur, caps] of Object.entries(v)) {
          if (!isObj(caps)) {
            if (caps === null) notes.push(`project limits.${cur}: null ignored (a project cannot remove caps)`);
            continue;
          }
          if (!Object.hasOwn(out.limits, cur) && isObj(out.limits["*"])) out.limits[cur] = { ...out.limits["*"] };
          const target = Object.hasOwn(out.limits, cur) ? out.limits[cur] : null;
          if (!isObj(target)) {
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
        if (Array.isArray(v.deny)) out.payees.deny = [...new Set([...out.payees.deny, ...v.deny])];
        if (Array.isArray(v.allow) && v.allow.length) {
          // With no global allowlist, the project list is strictly tighter
          // than "anyone". With one, keep both and require a payee to match
          // each. Filtering one glob list by another is not sound ("a*c"
          // passes as a literal against "a?c" but matches far more payees).
          if (out.payees.allow.length) out.payees.projectAllow = [...v.allow];
          else out.payees.allow = [...v.allow];
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
        else if (v !== out.autoApprove) notes.push("project autoApprove ignored (a project can only turn it off)");
        break;
      case "reservationTtlMinutes":
        out.reservationTtlMinutes = Math.max(out.reservationTtlMinutes, v);
        break;
      case "rules":
        // Project rules can add coverage for new tools but cannot pre-empt
        // the built-in extractors, so they go last.
        out._projectRules = v;
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

/**
 * @typedef {object} LoadedPolicy
 * @property {object} policy   the effective merged policy
 * @property {object[]} rules  extractor rules in match order (global, built-in, project)
 * @property {{global: string|null, project: string|null}} sources  files that were applied
 * @property {{global: string, project: string}} paths  where the files are looked for
 * @property {string[]} notes  human-readable warnings and errors
 * @property {boolean} broken  a policy file exists but could not be applied
 */

/**
 * Load and merge defaults, the global policy and the project policy for `cwd`.
 * Never throws for a bad file: it reports `broken` and notes instead.
 * @param {string} [cwd]
 * @returns {LoadedPolicy}
 */
export function loadPolicy(cwd) {
  const notes = [];
  const gPath = globalPolicyPath();
  const pPath = projectPolicyPath(cwd);
  const g = readPolicyFile(gPath, notes);
  const p = pPath === gPath ? null : readPolicyFile(pPath, notes);
  const broken = g === BROKEN || p === BROKEN;
  const gOk = g && g !== BROKEN ? g : null;
  const pOk = p && p !== BROKEN ? p : null;

  // Global deep-merges over the defaults, so `set limits.USD.daily 500` keeps
  // the default USD per-call cap. Set a cap to null to remove it.
  let merged = normalize(gOk ? deepMerge(DEFAULT_POLICY, gOk) : deepMerge(DEFAULT_POLICY, {}));

  if (pOk) {
    if (merged.projectCanLoosen) {
      const rules = [...(pOk.rules || []), ...merged.rules];
      merged = normalize(deepMerge(merged, pOk));
      merged.rules = rules;
    } else {
      merged = tightenMerge(merged, pOk, notes);
    }
  }

  const ruleList = [...merged.rules, ...(merged.disableDefaultRules ? [] : DEFAULT_RULES), ...(merged._projectRules || [])];
  delete merged._projectRules;

  return {
    policy: merged,
    rules: ruleList,
    sources: { global: gOk ? gPath : null, project: pOk ? pPath : null },
    paths: { global: gPath, project: pPath },
    notes,
    broken,
  };
}

/** Map a currency through `policy.aliases` (USDC -> USD). Returns null for no currency. */
export function resolveCurrency(policy, cur) {
  if (!cur) return null;
  const alias = Object.hasOwn(policy.aliases || {}, cur) ? policy.aliases[cur] : null;
  return alias ? String(alias).toUpperCase() : cur;
}

/**
 * The caps that apply to `cur`: its own entry, else the "*" catch-all, else null.
 * Own-property lookups only: a currency string from a tool call must never
 * resolve to something inherited from Object.prototype.
 */
export function limitsFor(policy, cur) {
  const limits = policy.limits || {};
  if (cur && Object.hasOwn(limits, cur) && isObj(limits[cur])) return limits[cur];
  if (Object.hasOwn(limits, "*") && isObj(limits["*"])) return limits["*"];
  return null;
}
