import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

test("fakepay speaks MCP over stdio", async () => {
  const c = spawn(process.execPath, [path.join(ROOT, "examples/fakepay/server.mjs")]);
  const replies = [];
  let buf = "";
  const waiters = [];
  c.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      replies.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
      waiters.shift()?.();
    }
  });
  const send = (m) => new Promise((res) => { waiters.push(res); c.stdin.write(JSON.stringify(m) + "\n"); });
  await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pay", arguments: { to: "acme", amount: 12.5 } } });
  await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_balance", arguments: {} } });
  c.kill();
  assert.equal(replies[0].result.serverInfo.name, "fakepay");
  assert.deepEqual(replies[1].result.tools.map((t) => t.name), ["pay", "refund", "get_balance", "list_payments"]);
  assert.match(replies[2].result.content[0].text, /PAID USD 12\.50 to acme/);
  assert.match(replies[3].result.content[0].text, /9987\.50/);
});
