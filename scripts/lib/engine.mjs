// The decision engine: PreToolUse / PostToolUse / PostToolUseFailure handlers.
// Each handler takes the parsed hook input and returns the JSON object to
// print on stdout (or null for "no opinion, normal permission flow").

import path from "node:path";
import { compileRules, matchRule, extract } from "./rules.mjs";
import { loadPolicy, resolveCurrency, limitsFor, payeeMatches } from "./policy.mjs";
import * as ledger from "./ledger.mjs";

const FIAT = new Set(["USD", "EUR", "GBP", "INR", "JPY", "CAD", "AUD", "SGD", "CHF"]);

export function fmt(n, cur) {
  if (n === null || n === undefined || Number.isNaN(n)) return "an unknown amount";
  if (cur === "USD") return `$${Number(n).toFixed(2)}`;
  if (FIAT.has(cur)) return `${Number(n).toFixed(2)} ${cur}`;
  const s = Number(n).toFixed(6).replace(/\.?0+$/, "");
  return cur ? `${s} ${cur}` : s;
}

export function shortTool(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || "");
  return m ? `${m[1]}.${m[2]}` : name;
}

function pre(decision, reason, extra = {}) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  if (extra.systemMessage) out.systemMessage = extra.systemMessage;
  return out;
}

const NO_SPLIT =
  " Do not retry with a smaller amount or split it into several payments to get under the cap; tell the user what was blocked and let them decide (they can change limits with /leash:set).";

function policyHint(loaded) {
  const src = [loaded.sources.global, loaded.sources.project].filter(Boolean);
  return src.length ? ` Policy: ${src.map(tilde).join(" + ")}.` : " Policy: built-in defaults.";
}

function tilde(p) {
  const home = process.env.HOME || "";
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

// ---------------------------------------------------------------- PreToolUse

export function handlePre(input, { now = Date.now() } = {}) {
  const tool = input.tool_name || "";
  const toolInput = input.tool_input || {};
  if (["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) return guard(input);
  if (!tool.startsWith("mcp__")) return null;

  const loaded = loadPolicy(input.cwd);
  const { policy } = loaded;
  const rule = matchRule(compileRules(loaded.rules), tool, policy.ignore);
  if (!rule) return null;
  if (!policy.enabled && !loaded.broken) return null;

  const ex = extract(rule, toolInput);
  const currency = resolveCurrency(policy, ex.currency);
  const label = shortTool(tool);
  const base = {
    session: input.session_id || null,
    tool,
    rule: rule.id,
    amount: ex.amount,
    currency,
    rawCurrency: ex.currency !== currency ? ex.currency : undefined,
    payee: ex.payee,
    cwd: input.cwd,
  };
  const hold = input.tool_use_id || ledger.newId();
  const what = `${fmt(ex.amount, currency)} to ${ex.payee || "an unknown payee"} via ${label}`;

  // ---- static checks (no ledger needed)
  let verdict = staticVerdict(policy, ex, currency, loaded);

  // ---- dry run: evaluate everything, enforce nothing
  if (policy.dryRun) {
    if (!verdict) verdict = budgetVerdict(policy, base, currency, ledger.readAll(), now);
    const would = verdict ? verdict.decision : "allow";
    const reason = verdict ? verdict.reason : "within limits";
    ledger.append({ ...base, event: "decision", hold, decision: "dry-run", would, reason });
    return {
      systemMessage: `leash (dry-run): would ${would} ${what}: ${reason}`,
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `leash dry-run: this call would be ${would === "allow" ? "allowed" : would + "ed"} (${reason}). Dry-run mode does not block.` },
    };
  }

  if (verdict && verdict.decision === "deny") {
    ledger.append({ ...base, event: "decision", hold, decision: "deny", code: verdict.code, reason: verdict.reason });
    return pre("deny", `leash blocked ${what}: ${verdict.reason}.${NO_SPLIT}${policyHint(loaded)}`, {
      systemMessage: `leash: DENIED ${what} (${verdict.reason})`,
    });
  }
  if (verdict && verdict.decision === "ask" && (ex.amount === null || !currency || !limitsFor(policy, currency))) {
    // Nothing we can budget against, so no hold: just escalate.
    ledger.append({ ...base, event: "decision", hold, decision: "ask", code: verdict.code, reason: verdict.reason });
    return pre("ask", `leash: ${what} needs your approval: ${verdict.reason}.`);
  }

  // ---- budget checks, race-free: reserve first, then count what came before.
  const nonce = ledger.newId();
  ledger.append({ ...base, event: "reserve", hold, nonce });
  const all = ledger.readAll();
  const idx = all.findIndex((e) => e.event === "reserve" && e.nonce === nonce);
  const before = idx >= 0 ? all.slice(0, idx) : all;
  const budget = budgetVerdict(policy, base, currency, before, now);
  if (budget) {
    ledger.append({ ...base, event: "release", hold, reason: budget.code });
    ledger.append({ ...base, event: "decision", hold, decision: "deny", code: budget.code, reason: budget.reason });
    return pre("deny", `leash blocked ${what}: ${budget.reason}.${NO_SPLIT}${policyHint(loaded)}`, {
      systemMessage: `leash: DENIED ${what} (${budget.reason})`,
    });
  }

  if (verdict && verdict.decision === "ask") {
    // Keep the hold: if the user approves, PostToolUse settles it.
    ledger.append({ ...base, event: "decision", hold, decision: "ask", code: verdict.code, reason: verdict.reason });
    return pre("ask", `leash: ${what} needs your approval: ${verdict.reason}.`);
  }

  ledger.append({ ...base, event: "decision", hold, decision: "allow", reason: "within limits" });
  if (policy.autoApprove) return pre("allow", `leash: ${what} is within limits.`);
  return null;
}

function staticVerdict(policy, ex, currency, loaded) {
  if (loaded.broken) {
    return { decision: "ask", code: "POLICY_UNREADABLE", reason: `a leash policy file could not be parsed (${loaded.notes.join("; ")})` };
  }
  if (ex.payee && payeeMatches(policy.payees.deny, ex.payee)) {
    return { decision: "deny", code: "PAYEE_DENIED", reason: `payee "${ex.payee}" is on the deny list` };
  }
  if (ex.amount === null) {
    return { decision: policy.unknownAmount, code: "AMOUNT_UNKNOWN", reason: "leash could not determine the amount from the tool input" };
  }
  if (!(ex.amount > 0)) {
    return { decision: "ask", code: "AMOUNT_INVALID", reason: `amount ${ex.amount} is not a positive number` };
  }
  if (!currency) {
    return { decision: policy.unknownCurrency, code: "CURRENCY_UNKNOWN", reason: "leash could not determine the currency" };
  }
  const lim = limitsFor(policy, currency);
  if (!lim) {
    return { decision: policy.unlistedCurrency, code: "CURRENCY_UNLISTED", reason: `no limits are configured for ${currency}` };
  }
  if (typeof lim.perCall === "number" && ex.amount > lim.perCall) {
    return { decision: "deny", code: "OVER_PER_CALL", reason: `over the per-call cap of ${fmt(lim.perCall, currency)}` };
  }
  if (policy.payees.allow.length) {
    if (!ex.payee) return { decision: "ask", code: "PAYEE_UNKNOWN", reason: "a payee allowlist is set but the payee could not be determined" };
    if (!payeeMatches(policy.payees.allow, ex.payee)) {
      return { decision: "deny", code: "PAYEE_NOT_ALLOWED", reason: `payee "${ex.payee}" is not on the allowlist` };
    }
  }
  if (typeof lim.confirmAbove === "number" && ex.amount > lim.confirmAbove) {
    return { decision: "ask", code: "CONFIRM_THRESHOLD", reason: `it is above the ${fmt(lim.confirmAbove, currency)} confirmation threshold` };
  }
  return null;
}

function budgetVerdict(policy, base, currency, entries, now) {
  const lim = limitsFor(policy, currency);
  if (!lim || base.amount === null) return null;
  const ttlMs = (policy.reservationTtlMinutes || 15) * 60_000;
  const t = ledger.totals(entries, { session: base.session, currency, now, ttlMs });
  const amt = ledger.toMicro(base.amount);
  if (typeof lim.perSession === "number" && ledger.toMicro(t.session) + amt > ledger.toMicro(lim.perSession)) {
    return {
      decision: "deny",
      code: "OVER_SESSION",
      reason: `this session has already spent ${fmt(t.session, currency)} and the per-session cap is ${fmt(lim.perSession, currency)}`,
    };
  }
  if (typeof lim.daily === "number" && ledger.toMicro(t.day) + amt > ledger.toMicro(lim.daily)) {
    return {
      decision: "deny",
      code: "OVER_DAILY",
      reason: `${fmt(t.day, currency)} has already been spent today and the daily cap is ${fmt(lim.daily, currency)}`,
    };
  }
  return null;
}

// ------------------------------------------------- tamper guard (Bash/Edit)

const CONFIG_RE = /(^|[\s"'\/=])\.?leash\.json\b|leash\/ledger\.jsonl|leash\.mjs["']?\s+(set|add|remove|reset)\b|LEASH_(HOME|LEDGER|GLOBAL_CONFIG)=/;

function guard(input) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  let touches = false;
  if (tool === "Bash") {
    touches = CONFIG_RE.test(String(ti.command || ""));
  } else {
    const f = String(ti.file_path || ti.notebook_path || "");
    const b = path.basename(f);
    touches = b === "leash.json" || b === ".leash.json" || /leash[\/\\]ledger\.jsonl$/.test(f);
  }
  if (!touches) return null;
  const loaded = loadPolicy(input.cwd);
  if (!loaded.policy.guardConfig) return null;
  return pre(
    "ask",
    "leash: this changes your spending policy or ledger. Approve only if you asked for this change.",
  );
}

// --------------------------------------------- PostToolUse / ...Failure

export function handlePost(input, { failed = false } = {}) {
  const tool = input.tool_name || "";
  if (!tool.startsWith("mcp__")) return null;
  const loaded = loadPolicy(input.cwd);
  const { policy } = loaded;
  const rule = matchRule(compileRules(loaded.rules), tool, policy.ignore);
  if (!rule) return null;

  const ex = extract(rule, input.tool_input || {});
  const currency = resolveCurrency(policy, ex.currency);
  const hold = input.tool_use_id || ledger.newId();
  const base = { session: input.session_id || null, tool, rule: rule.id, amount: ex.amount, currency, payee: ex.payee, cwd: input.cwd };

  const resp = input.tool_response;
  const errored =
    failed ||
    (resp && typeof resp === "object" && !Array.isArray(resp) && resp.isError === true);

  if (errored) {
    ledger.append({ ...base, event: "release", hold, reason: "TOOL_FAILED", error: truncate(input.error || "") });
    return null;
  }

  ledger.append({ ...base, event: "settle", hold, dryRun: policy.dryRun || undefined });
  if (ex.amount === null || !currency) return null;
  const lim = limitsFor(policy, currency);
  if (!lim) return null;
  const t = ledger.totals(ledger.readAll(), { currency, session: base.session, ttlMs: (policy.reservationTtlMinutes || 15) * 60_000 });
  const parts = [`today ${fmt(t.day, currency)}${lim.daily != null ? ` of ${fmt(lim.daily, currency)}` : ""}`];
  if (lim.perSession != null) parts.push(`session ${fmt(t.session, currency)} of ${fmt(lim.perSession, currency)}`);
  return {
    hookSpecificOutput: {
      hookEventName: failed ? "PostToolUseFailure" : "PostToolUse",
      additionalContext: `leash recorded ${fmt(ex.amount, currency)} to ${ex.payee || "unknown payee"} (${parts.join(", ")}).`,
    },
  };
}

function truncate(s, n = 300) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + "..." : s;
}
