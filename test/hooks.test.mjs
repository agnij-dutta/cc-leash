import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, uid } from "./helpers.mjs";

// Built-in defaults: USD perCall 50, perSession 100, daily 200, confirmAbove 20.

test("non-payment MCP tool: no output, no ledger entry", () => {
  const s = sandbox();
  const r = s.run("pre", s.fixture("pre-github-list-issues"));
  assert.equal(r.status, 0);
  assert.equal(r.json, null);
  assert.equal(s.ledger().length, 0);
});

test("the demo: $500 via fakepay is denied with a clear reason", () => {
  const s = sandbox();
  const r = s.run("pre", s.fixture("pre-fakepay-pay-500"));
  assert.equal(r.status, 0);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /\$500\.00 to acme-supplies via fakepay\.pay/);
  assert.match(r.reason, /per-call cap of \$50\.00/);
  assert.match(r.reason, /Do not retry with a smaller amount/);
  assert.match(r.json.systemMessage, /DENIED/);
  const led = s.ledger();
  assert.equal(led.length, 1);
  assert.equal(led[0].decision, "deny");
  assert.equal(led[0].code, "OVER_PER_CALL");
  assert.equal(led[0].amount, 500);
});

test("in-policy payment passes through to normal permissions and reserves a hold", () => {
  const s = sandbox();
  const r = s.run("pre", s.fixture("pre-fakepay-pay-15"));
  assert.equal(r.json, null, "no decision = normal permission flow");
  const led = s.ledger();
  assert.deepEqual(led.map((e) => e.event), ["reserve", "decision"]);
  assert.equal(led[1].decision, "allow");
});

test("autoApprove: in-policy payment returns allow", () => {
  const s = sandbox({ global: { autoApprove: true } });
  const r = s.run("pre", s.fixture("pre-fakepay-pay-15"));
  assert.equal(r.decision, "allow");
});

test("unknown amount escalates to the user (ask), never silently allows", () => {
  const s = sandbox();
  const r = s.run("pre", s.fixture("pre-fakepay-pay-noamount"));
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /could not determine the amount/);
  assert.equal(s.ledger()[0].code, "AMOUNT_UNKNOWN");
});

test("unknownAmount: deny is honored", () => {
  const s = sandbox({ global: { unknownAmount: "deny" } });
  assert.equal(s.run("pre", s.fixture("pre-fakepay-pay-noamount")).decision, "deny");
});

test("confirmation threshold: $25 asks, $15 passes", () => {
  const s = sandbox();
  const ask = s.run("pre", s.fixture("pre-fakepay-pay-15", { tool_input: { amount: 25 }, tool_use_id: uid() }));
  assert.equal(ask.decision, "ask");
  assert.match(ask.reason, /\$20\.00 confirmation threshold/);
  const ok = s.run("pre", s.fixture("pre-fakepay-pay-15", { tool_use_id: uid() }));
  assert.equal(ok.json, null);
});

test("Stripe amounts are minor units: refund of 1500 cents is $15", () => {
  const s = sandbox();
  const r = s.run("pre", s.fixture("pre-stripe-create-refund"));
  assert.equal(r.json, null);
  const reserve = s.ledger().find((e) => e.event === "reserve");
  assert.equal(reserve.amount, 15);
  assert.equal(reserve.currency, "USD");
  const big = s.run("pre", s.fixture("pre-stripe-create-refund", { tool_input: { amount: 250000 }, tool_use_id: uid() }));
  assert.equal(big.decision, "deny");
  assert.match(big.reason, /\$2500\.00/);
});

test("Stripe payment link has no amount in its input: ask", () => {
  const s = sandbox();
  assert.equal(s.run("pre", s.fixture("pre-stripe-create-payment-link")).decision, "ask");
});

test("capline-mcp pay: USDC counts against USD caps via alias", () => {
  const s = sandbox();
  const r = s.run("pre", s.fixture("pre-capline-pay"));
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /\$1000\.00 to DataVendor/);
  assert.equal(s.ledger()[0].rawCurrency, "USDC");
});

test("PayPal: nested string amount and currency are extracted (EUR unlisted -> ask)", () => {
  const s = sandbox();
  const r = s.run("pre", s.fixture("pre-paypal-create-order"));
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /1250\.00 EUR/);
  assert.match(r.reason, /no limits are configured for EUR/);
  const s2 = sandbox({ global: { limits: { EUR: { perCall: 1000 } } } });
  const r2 = s2.run("pre", s2.fixture("pre-paypal-create-order"));
  assert.equal(r2.decision, "deny");
  assert.match(r2.reason, /per-call cap of 1000\.00 EUR/);
});

test("AgentKit transfer: ETH caps apply when configured", () => {
  const s = sandbox({ global: { limits: { USD: { perCall: 50 }, ETH: { perCall: 0.1 } } } });
  const r = s.run("pre", s.fixture("pre-agentkit-transfer"));
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /0\.25 ETH/);
  assert.match(r.reason, /per-call cap of 0\.1 ETH/);
});

test("payee deny list blocks even tiny payments (glob, case-insensitive)", () => {
  const s = sandbox({ global: { payees: { deny: ["ACME-*"] } } });
  const r = s.run("pre", s.fixture("pre-fakepay-pay-15"));
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /deny list/);
});

test("payee allowlist: off-list payee denied, on-list allowed", () => {
  const s = sandbox({ global: { payees: { allow: ["github-sponsors", "acme-*"] } } });
  assert.equal(s.run("pre", s.fixture("pre-fakepay-pay-15")).json, null);
  const r = s.run("pre", s.fixture("pre-fakepay-pay-15", { tool_input: { to: "totally-legit-vendor" }, tool_use_id: uid() }));
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /not on the allowlist/);
});

function payAndSettle(s, amount, session) {
  const id = uid();
  const pre = s.run("pre", s.fixture("pre-fakepay-pay-15", { tool_input: { amount }, tool_use_id: id, session_id: session }));
  if (pre.decision === "deny") return pre;
  s.run("post", s.fixture("post-fakepay-pay-15", { tool_input: { amount }, tool_use_id: id, session_id: session }));
  return pre;
}

test("per-session cap: third $40 payment in one session is denied", () => {
  const s = sandbox({ global: { limits: { USD: { perCall: 50, perSession: 100, daily: 1000, confirmAbove: null } } } });
  assert.equal(payAndSettle(s, 40, "sess-A").decision, null);
  assert.equal(payAndSettle(s, 40, "sess-A").decision, null);
  const third = payAndSettle(s, 40, "sess-A");
  assert.equal(third.decision, "deny");
  assert.match(third.reason, /this session has already spent \$80\.00 and the per-session cap is \$100\.00/);
  // a different session has its own session budget
  assert.equal(payAndSettle(s, 40, "sess-B").decision, null);
});

test("daily cap spans sessions", () => {
  const s = sandbox({ global: { limits: { USD: { perCall: 50, perSession: 1000, daily: 100, confirmAbove: null } } } });
  assert.equal(payAndSettle(s, 50, "s1").decision, null);
  assert.equal(payAndSettle(s, 50, "s2").decision, null);
  const r = payAndSettle(s, 1, "s3");
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /\$100\.00 has already been spent today and the daily cap is \$100\.00/);
});

test("failed payment (PostToolUseFailure) releases its hold", () => {
  const s = sandbox({ global: { limits: { USD: { perCall: 50, daily: 20 } } } });
  assert.equal(s.run("pre", s.fixture("pre-fakepay-pay-15")).json, null);
  // While the $15 hold is pending, another $15 would breach the $20 daily cap.
  const blocked = s.run("pre", s.fixture("pre-fakepay-pay-15", { tool_use_id: uid() }));
  assert.equal(blocked.decision, "deny");
  s.run("post-failure", s.fixture("postfail-fakepay-pay-15"));
  const after = s.run("pre", s.fixture("pre-fakepay-pay-15", { tool_use_id: uid() }));
  assert.equal(after.json, null, "hold released, so the budget is free again");
});

test("MCP result with isError in PostToolUse is not counted as spend", () => {
  const s = sandbox({ global: { limits: { USD: { perCall: 50, daily: 20 } } } });
  s.run("pre", s.fixture("pre-fakepay-pay-15"));
  s.run("post", s.fixture("post-fakepay-pay-15", { tool_response: { content: [{ type: "text", text: "nope" }], isError: true } }));
  assert.equal(s.run("pre", s.fixture("pre-fakepay-pay-15", { tool_use_id: uid() })).json, null);
});

test("stale holds expire after reservationTtlMinutes", () => {
  const s = sandbox({ global: { limits: { USD: { perCall: 50, daily: 20 } }, reservationTtlMinutes: 5 } });
  fs.mkdirSync(path.dirname(s.ledgerFile), { recursive: true });
  const old = new Date(Date.now() - 6 * 60_000).toISOString();
  fs.writeFileSync(s.ledgerFile, JSON.stringify({ v: 1, ts: old, event: "reserve", hold: "toolu_stale", nonce: "n1", amount: 15, currency: "USD", session: "x" }) + "\n");
  assert.equal(s.run("pre", s.fixture("pre-fakepay-pay-15")).json, null);
});

test("concurrent sessions cannot jointly overspend (lock-free reserve-then-check)", async () => {
  const s = sandbox({ global: { limits: { USD: { perCall: 50, perSession: 1000, daily: 100, confirmAbove: null } } } });
  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      s.runAsync("pre", s.fixture("pre-fakepay-pay-15", { tool_input: { amount: 40 }, tool_use_id: `toolu_par${i}`, session_id: `par-${i}` })),
    ),
  );
  const allowed = results.filter((r) => r.decision === null).length;
  const denied = results.filter((r) => r.decision === "deny").length;
  assert.equal(allowed, 2, "only two $40 payments fit under a $100 daily cap");
  assert.equal(denied, N - 2);
  const live = s.ledger().filter((e) => e.event === "reserve").length - s.ledger().filter((e) => e.event === "release").length;
  assert.equal(live, 2);
});

test("dry-run: logs what would happen and blocks nothing", () => {
  const s = sandbox({ global: { dryRun: true } });
  const r = s.run("pre", s.fixture("pre-fakepay-pay-500"));
  assert.equal(r.decision, null);
  assert.match(r.json.systemMessage, /dry-run.*would deny.*per-call cap/);
  const e = s.ledger()[0];
  assert.equal(e.decision, "dry-run");
  assert.equal(e.would, "deny");
});

test("a project .leash.json cannot loosen the global policy", () => {
  const s = sandbox({
    global: { limits: { USD: { perCall: 50, perSession: 100, daily: 200 } } },
    project: { limits: { USD: { perCall: 100000, daily: 100000 } }, dryRun: true, enabled: false, payees: { deny: ["mallory-*"] } },
  });
  const r = s.run("pre", s.fixture("pre-fakepay-pay-500"));
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /per-call cap of \$50\.00/);
  const pol = JSON.parse(s.cli("policy", "--json").stdout);
  assert.equal(pol.policy.dryRun, false);
  assert.equal(pol.policy.enabled, true);
  assert.deepEqual(pol.policy.payees.deny, ["mallory-*"], "project CAN add to the deny list");
  assert.ok(pol.notes.some((n) => /dryRun ignored/.test(n)));
});

test("a project .leash.json can tighten the global policy", () => {
  const s = sandbox({ project: { limits: { USD: { perCall: 10 } } } });
  const r = s.run("pre", s.fixture("pre-fakepay-pay-15"));
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /per-call cap of \$10\.00/);
});

test("projectCanLoosen lets the project raise caps", () => {
  const s = sandbox({
    global: { projectCanLoosen: true },
    project: { limits: { USD: { perCall: 1000, perSession: 1000, daily: 1000, confirmAbove: 1000 } } },
  });
  assert.equal(s.run("pre", s.fixture("pre-fakepay-pay-500")).json, null);
});

test("custom rule extracts from a nonstandard tool", () => {
  const s = sandbox({
    global: { rules: [{ id: "acmebank", match: "^mcp__acmebank__wire$", amount: ["wire.cents"], scale: 100, currency: ["=USD"], payee: ["wire.beneficiary.name"] }] },
  });
  const r = s.run("pre", {
    session_id: "s", cwd: s.proj, hook_event_name: "PreToolUse", tool_use_id: uid(),
    tool_name: "mcp__acmebank__wire",
    tool_input: { wire: { cents: 990000, beneficiary: { name: "Mallory LLC" } } },
  });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /\$9900\.00 to Mallory LLC/);
});

test("tamper guard: Bash editing the leash policy asks; normal Bash is untouched", () => {
  const s = sandbox();
  const r = s.run("pre", s.fixture("pre-bash-edit-policy"));
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /changes your spending policy/);
  const ok = s.run("pre", s.fixture("pre-bash-edit-policy", { tool_input: { command: "npm test" } }));
  assert.equal(ok.json, null);
  const w = s.run("pre", { session_id: "s", cwd: s.proj, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(s.proj, ".leash.json"), content: "{}" } });
  assert.equal(w.decision, "ask");
});

test("fail closed: garbage stdin and corrupt policy both escalate", () => {
  const s = sandbox();
  assert.equal(s.run("pre", "{not json").decision, "ask");
  const s2 = sandbox({ global: "{ this is not json" });
  const r = s2.run("pre", s2.fixture("pre-fakepay-pay-15"));
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /could not be parsed/);
});

test("disabled policy (global) lets payments through untouched", () => {
  const s = sandbox({ global: { enabled: false } });
  assert.equal(s.run("pre", s.fixture("pre-fakepay-pay-500")).json, null);
  assert.equal(s.ledger().length, 0);
});

test("ledger accounting: status --json totals equal settled + pending", () => {
  const s = sandbox({ global: { limits: { USD: { perCall: 50, perSession: 1000, daily: 1000, confirmAbove: 1000 } } } });
  payAndSettle(s, 12.34, "a");
  payAndSettle(s, 0.66, "a");
  payAndSettle(s, 7, "b");
  s.run("pre", s.fixture("pre-fakepay-pay-15", { tool_input: { amount: 5 }, tool_use_id: uid() })); // pending hold
  s.run("pre", s.fixture("pre-fakepay-pay-500", { tool_use_id: uid() })); // denied: not counted
  const st = JSON.parse(s.cli("status", "--json").stdout);
  assert.equal(st.today.USD.day, 25);
  assert.equal(st.today.USD.pending, 5);
  assert.equal(st.today.USD.calls, 4);
  const text = s.cli("status").stdout;
  assert.match(text, /\$25\.00 of \$1000\.00/);
  assert.match(text, /DENY/);
  const led = s.cli("ledger", "50").stdout;
  assert.match(led, /PAID/);
});

test("PostToolUse adds spend context for Claude", () => {
  const s = sandbox();
  s.run("pre", s.fixture("pre-fakepay-pay-15"));
  const r = s.run("post", s.fixture("post-fakepay-pay-15"));
  assert.match(r.json.hookSpecificOutput.additionalContext, /leash recorded \$15\.00 to acme-supplies \(today \$15\.00 of \$200\.00, session \$15\.00 of \$100\.00\)/);
  const settled = s.ledger().filter((e) => e.event === "settle");
  assert.equal(settled.length, 1);
});

test("CLI set/add/remove edit the global policy file", () => {
  const s = sandbox();
  assert.equal(s.cli("set", "limits.USD.daily", "500").status, 0);
  assert.equal(s.cli("add", "payees.deny", "*@scam.example").status, 0);
  assert.equal(s.cli("add", "payees.deny", "evil").status, 0);
  assert.equal(s.cli("remove", "payees.deny", "evil").status, 0);
  assert.equal(s.cli("set", "dryRun", "true").status, 0);
  const g = JSON.parse(fs.readFileSync(s.env.LEASH_GLOBAL_CONFIG, "utf8"));
  assert.deepEqual(g, { limits: { USD: { daily: 500 } }, payees: { deny: ["*@scam.example"] }, dryRun: true });
});
