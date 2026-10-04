#!/usr/bin/env node
// fakepay: a pretend payment MCP server for trying cc-leash without real
// credentials. Speaks MCP over stdio (newline-delimited JSON-RPC 2.0).
// Zero dependencies. No money moves anywhere; "payments" live in memory and,
// if FAKEPAY_LOG is set, are appended to that file.
//
// Tools: pay, refund, get_balance, list_payments

import fs from "node:fs";
import readline from "node:readline";

const state = { balance: 10_000, payments: [] };
const LOG = process.env.FAKEPAY_LOG;

const TOOLS = [
  {
    name: "pay",
    description: "Send a payment from the company account to a payee. Moves real (pretend) money immediately.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Payee name, email or account id" },
        amount: { type: "number", description: "Amount in major units, e.g. 25.50 dollars" },
        currency: { type: "string", description: "ISO currency code", default: "USD" },
        memo: { type: "string", description: "What the payment is for" },
      },
      required: ["to", "amount"],
    },
  },
  {
    name: "refund",
    description: "Refund a previous payment (or part of it) by payment id.",
    inputSchema: {
      type: "object",
      properties: {
        payment_id: { type: "string" },
        amount: { type: "number", description: "Amount to refund in major units" },
        currency: { type: "string", default: "USD" },
        to: { type: "string", description: "Who receives the refund" },
      },
      required: ["payment_id", "amount"],
    },
  },
  {
    name: "get_balance",
    description: "Current account balance.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_payments",
    description: "Payments made in this session.",
    inputSchema: { type: "object", properties: {} },
  },
];

function text(s, isError = false) {
  return { content: [{ type: "text", text: s }], isError };
}

function callTool(name, a = {}) {
  switch (name) {
    case "pay": {
      const amount = Number(a.amount);
      if (!(amount > 0)) return text(`invalid amount: ${a.amount}`, true);
      if (amount > state.balance) return text(`insufficient funds: balance $${state.balance.toFixed(2)}`, true);
      const p = { id: `pay_${(state.payments.length + 1).toString().padStart(4, "0")}`, to: a.to, amount, currency: a.currency || "USD", memo: a.memo || "", ts: new Date().toISOString() };
      state.balance -= amount;
      state.payments.push(p);
      if (LOG) fs.appendFileSync(LOG, JSON.stringify(p) + "\n");
      return text(`PAID ${p.currency} ${amount.toFixed(2)} to ${a.to} (${p.id}). Balance: $${state.balance.toFixed(2)}`);
    }
    case "refund": {
      const amount = Number(a.amount);
      if (!(amount > 0)) return text(`invalid amount: ${a.amount}`, true);
      state.balance -= amount;
      return text(`REFUNDED ${a.currency || "USD"} ${amount.toFixed(2)} on ${a.payment_id}. Balance: $${state.balance.toFixed(2)}`);
    }
    case "get_balance":
      return text(`Balance: $${state.balance.toFixed(2)}`);
    case "list_payments":
      return text(state.payments.length ? state.payments.map((p) => `${p.id} ${p.currency} ${p.amount} -> ${p.to}`).join("\n") : "(no payments)");
    default:
      return null;
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, "parse error");
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fakepay", version: "0.1.0" },
        instructions: "fakepay is a demo payment server. No real money moves.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const r = callTool(params?.name, params?.arguments);
      return r ? reply(id, r) : fail(id, -32602, `unknown tool: ${params?.name}`);
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
});
process.stderr.write("fakepay ready (demo server, no real money)\n");
