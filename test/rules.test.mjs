import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, compileRules, matchRule, extract, parseAmount, getPath } from "../scripts/lib/rules.mjs";

const rules = compileRules(DEFAULT_RULES);
const id = (tool) => matchRule(rules, tool)?.id ?? null;

test("payment tools match the right rule", () => {
  assert.equal(id("mcp__capline__pay"), "capline");
  assert.equal(id("mcp__plugin_capline_capline-mcp__pay"), "capline");
  assert.equal(id("mcp__fakepay__pay"), "fakepay");
  assert.equal(id("mcp__stripe__create_refund"), "stripe");
  assert.equal(id("mcp__stripe__create_payment_link"), "stripe");
  assert.equal(id("mcp__paypal__create_order"), "paypal");
  assert.equal(id("mcp__agentkit__WalletActionProvider_native_transfer"), "wallet");
  assert.equal(id("mcp__coinbase-cdp__send_tokens"), "wallet");
  assert.equal(id("mcp__x402__fetch_with_payment"), "x402");
  assert.equal(id("mcp__mystery__sendPayment"), "generic");
  assert.equal(id("mcp__shop__checkout"), "generic");
  assert.equal(id("mcp__bank__wire_transfer"), "generic");
});

test("read-only and look-alike tools do not match", () => {
  for (const t of [
    "mcp__stripe__list_refunds",
    "mcp__stripe__retrieve_balance",
    "mcp__paypal__get_order",
    "mcp__capline__mandate_status",
    "mcp__capline__create_mandate",
    "mcp__fakepay__get_balance",
    "mcp__fakepay__list_payments",
    "mcp__github__transfer_issue",
    "mcp__github__list_issues",
    "mcp__ui__update_tooltip",
    "mcp__db__repayment_schedule_report",
    "mcp__wallet__get_wallet_details",
    "Bash",
  ]) {
    assert.equal(id(t), null, t);
  }
});

test("ignore list overrides rules", () => {
  assert.equal(matchRule(rules, "mcp__fakepay__pay", ["fakepay"]), null);
});

test("parseAmount handles common shapes", () => {
  assert.deepEqual(parseAmount(500), { amount: 500, currency: null });
  assert.deepEqual(parseAmount("500"), { amount: 500, currency: null });
  assert.deepEqual(parseAmount("$1,250.50"), { amount: 1250.5, currency: "USD" });
  assert.deepEqual(parseAmount("12.5 usdc"), { amount: 12.5, currency: "USDC" });
  assert.deepEqual(parseAmount({ value: "9.99", currency_code: "eur" }), { amount: 9.99, currency: "EUR" });
  assert.equal(parseAmount("lots"), null);
  assert.equal(parseAmount(NaN), null);
  assert.equal(parseAmount(true), null);
});

test("getPath supports dots, indices, literals and JSON-string args", () => {
  const o = { a: { b: [{ c: 7 }] }, s: '{"amount": 3}' };
  assert.equal(getPath(o, "a.b[0].c"), 7);
  assert.equal(getPath(o, "=USDC"), "USDC");
  assert.equal(getPath(o, "s.amount"), 3);
  assert.equal(getPath(o, "missing.x"), undefined);
});

test("extract uses the first present path and applies scale", () => {
  const r = matchRule(rules, "mcp__stripe__create_refund");
  assert.deepEqual(extract(r, { amount: 1999, payment_intent: "pi_1" }), { amount: 19.99, currency: "USD", payee: "pi_1", amountPath: "amount" });
  const g = matchRule(rules, "mcp__mystery__sendPayment");
  const ex = extract(g, { recipient: "bob", value: "42 GBP" });
  assert.equal(ex.amount, 42);
  assert.equal(ex.currency, "GBP");
  assert.equal(ex.payee, "bob");
});
