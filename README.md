# cc-leash

**A spending limit for Claude Code.**

cc-leash is a Claude Code plugin. Before any MCP tool call that moves money runs (Stripe, PayPal, x402, Coinbase AgentKit and other wallet tools, `capline-mcp`, or anything that looks like a payment), it reads the amount, currency and payee out of the call and checks them against your policy:

- per-call cap, per-session cap, daily cap, per currency
- payee allowlist and denylist
- a "confirm above" threshold that hands the decision to you
- dry-run mode to see what it would block before you turn it on

Every decision lands in an append-only ledger, so you can see what Claude spent today and what it tried to spend.

```
> Pay acme-supplies $500 for Q4 server credits

  fakepay.pay  {"to": "acme-supplies", "amount": 500}
  leash blocked $500.00 to acme-supplies via fakepay.pay:
  over the per-call cap of $100.00.
```

The limit is not a sentence in the prompt. It is a hook that runs outside the model, so the model can't talk its way past it.

## Try it in 60 seconds (no payment credentials)

The repo ships a fake payment MCP server, `fakepay`, so you can watch the leash work without touching real money.

```bash
git clone https://github.com/agnij-dutta/cc-leash && cd cc-leash
bash examples/demo/demo.sh
```

`demo.sh` starts Claude Code in a throwaway directory with this repo loaded through `--plugin-dir` (nothing gets installed), the `fakepay` server, a demo policy ($100 per call, $250 per session, $500 per day) and a throwaway ledger. Your own `~/.claude` is not touched. Then ask:

> Pay acme-supplies $20 for a domain renewal, then pay them $500 for Q4 server credits.

The $20 goes through. The $500 is denied with the reason. Run `/leash:status` to see the meter.

Non-interactive version:

```bash
bash examples/demo/demo.sh -p 'Pay acme-supplies $20, then pay them $500. Report what happened.' < /dev/null
```

## Install

From GitHub, in your shell:

```bash
claude plugin marketplace add agnij-dutta/cc-leash
claude plugin install leash@cc-leash
```

Or inside a session: `/plugin marketplace add agnij-dutta/cc-leash`, then `/plugin install leash@cc-leash`.

From a local clone:

```bash
claude plugin marketplace add ./cc-leash
claude plugin install leash@cc-leash
```

Or for a single session, without installing anything:

```bash
claude --plugin-dir ./cc-leash
```

Requires Node.js 18 or newer on your PATH. Zero npm dependencies.

## Commands

| Command | What it does |
|---|---|
| `/leash:status` | Spend today against each cap, pending holds, recent allow / deny / ask decisions |
| `/leash:ledger [N]` | The last N ledger rows |
| `/leash:set [change]` | Guided policy edit, e.g. `/leash:set daily USD cap to 500` |

The same things work from a terminal: `node scripts/leash.mjs status | ledger | policy | set | add | remove | check`.

## Policy

Two files, merged over built-in defaults:

1. `~/.claude/leash.json`: your global policy
2. `.leash.json` in the project root: per-project policy

```json
{
  "limits": {
    "USD": { "perCall": 50, "perSession": 100, "daily": 200, "confirmAbove": 20 },
    "ETH": { "perCall": 0.05, "daily": 0.2 }
  },
  "aliases": { "USDC": "USD", "USDT": "USD" },
  "payees": {
    "allow": [],
    "deny": ["*@protonmail.com"]
  },
  "unknownAmount": "ask",
  "dryRun": false
}
```

| Key | Default | Meaning |
|---|---|---|
| `limits.<CUR>.perCall` | USD 50 | Deny any single call above this |
| `limits.<CUR>.perSession` | USD 100 | Deny once one Claude Code session would go over this |
| `limits.<CUR>.daily` | USD 200 | Deny once all sessions today would go over this (local day) |
| `limits.<CUR>.confirmAbove` | USD 20 | Ask you before any call above this |
| `limits["*"]` | unset | Caps for any currency not listed |
| `aliases` | USDC, USDT, PYUSD, DAI, USDS to USD | Count one currency against another's caps |
| `payees.allow` / `payees.deny` | empty | Case-insensitive globs. A non-empty allowlist denies everyone else |
| `unknownAmount` | `ask` | When the amount can't be read: `ask`, `deny` or `allow` |
| `unknownCurrency` | `ask` | When the currency can't be read |
| `unlistedCurrency` | `ask` | When the currency has no caps configured |
| `dryRun` | `false` | Log what would happen, block nothing |
| `autoApprove` | `false` | `true` = in-policy calls skip the normal permission prompt. `false` = leash only blocks; you still approve tools as usual |
| `reservationTtlMinutes` | 15 | How long an approved call holds its amount if it never completes |
| `guardConfig` | `true` | Ask before Claude edits the policy or ledger, or runs `leash set` |
| `projectCanLoosen` | `false` | Let a project `.leash.json` raise limits (global only) |
| `rules` | `[]` | Extra extractor rules for your own payment tools (see below) |
| `ignore` | `[]` | Tool-name regexes that are never treated as payments |

Amounts are in major units (dollars, not cents). Set a cap to `null` to remove it.

### Project files can only tighten

A `.leash.json` comes with whatever repo you cloned, and a repo is not necessarily on your side. So by default a project policy can only make things stricter: lower caps, more denied payees, stricter fallbacks. It can't raise a cap, turn on dry-run, disable leash or remap currencies. `/leash:status` lists anything it ignored. If you trust your projects, set `"projectCanLoosen": true` in the global file.

## Which tools it watches

Rules are tried in order; the first match wins. Your own `rules` come first.

| Rule | Tools | Notes |
|---|---|---|
| `capline` | `mcp__*capline*__pay` | Currency USDC |
| `fakepay` | the demo server | |
| `stripe` | `create_refund`, `create_payment_intent`, `create_payout`, `create_transfer`, `create_payment_link`, `finalize_invoice`, `create_invoice_item`, ... | Amounts in cents, divided by 100. Payment links carry a price id, not an amount, so they ask |
| `paypal` | `create_order`, `capture_order`, `create_refund`, `create_payout`, `send_invoice`, ... | Reads `purchase_units[0].amount.value` and friends |
| `wallet` | AgentKit, CDP, and other wallet servers: `transfer`, `send`, `trade`, `swap`, `withdraw`, `bridge` | Currency from `assetId` / `token` |
| `x402` | `x402`, `pay_for`, `fetch_with_payment`, `make_payment` | |
| `generic` | any MCP tool with `pay`, `payment`, `transfer`, `payout`, `refund`, `charge`, `withdraw`, `purchase`, `checkout`, ... in its name | Read-only names (`get_`, `list_`, `*_status`, `*_balance`, ...) are excluded |

Check what leash would extract from a call, without side effects:

```bash
node scripts/leash.mjs check mcp__stripe__create_refund '{"amount": 1999, "payment_intent": "pi_1"}'
```

Add a rule for your own tool:

```json
{
  "rules": [
    {
      "id": "acmebank",
      "match": "^mcp__acmebank__wire$",
      "amount": ["wire.cents"],
      "scale": 100,
      "currency": ["wire.currency", "=USD"],
      "payee": ["wire.beneficiary.name"]
    }
  ]
}
```

Paths are dotted with `[n]` indexes. The first path that has a value wins. A path starting with `=` is a literal. If no amount can be found, the call is escalated to you, not allowed.

## How it works

- **PreToolUse** (matcher `mcp__.*`) decides. A denial returns `permissionDecision: "deny"` with a reason Claude sees, including an instruction not to split the payment into smaller ones. Calls that fit the policy return nothing, so your normal permission flow still applies (unless `autoApprove` is on).
- **PostToolUse** settles the payment in the ledger and tells Claude how much budget is left. **PostToolUseFailure** (which is also where MCP results with `isError: true` land) releases the hold.
- **Ledger**: `~/.claude/leash/ledger.jsonl`, append-only, one JSON object per line, one `write` per line, read without locks. A half-written trailing line is skipped.
- **No double spend across parallel sessions, without a lock**: an approved call first appends a `reserve` line, then reads the ledger and only counts what came before its own line. File order is the same for every reader, so when two sessions race for the last $60 of a $100 cap, the second one sees the first and denies itself. The test suite fires 8 concurrent $40 payments at a $100 daily cap and exactly 2 get through.
- **Fails closed**: if the hook crashes or a policy file is corrupt, the payment is escalated to you. A crashing hook would otherwise count as a non-blocking error, and the payment would go through.
- **Guards itself**: Bash commands and file edits that touch `leash.json`, `.leash.json` or the ledger need your approval, so Claude can't quietly raise its own limit.

Environment overrides: `LEASH_HOME` (ledger directory), `LEASH_LEDGER` (ledger file), `LEASH_GLOBAL_CONFIG` (global policy path). `CLAUDE_CONFIG_DIR` is respected.

## What it does not do

cc-leash governs what Claude Code does through MCP tools. It is a client-side control:

- If Claude can reach a payment API another way, for example `curl` to the Stripe API with a key in your environment, leash does not see that. Keep payment credentials inside the MCP server, not in the shell.
- It trusts the tool input. If a tool charges something other than what its arguments say, leash records the arguments.
- Anyone with access to your machine can edit the policy.

For limits that hold even when the client is compromised, enforce them where the money is. [Capline](https://github.com/agnij-dutta/capline) puts the mandate on chain; cc-leash is the guard rail in front of it.

## Development

```bash
npm test                 # node --test, no dependencies
npm run validate         # claude plugin validate
```

Tests feed recorded hook payloads (`test/fixtures/`) to the hook on stdin and assert the allow / deny / ask output and the ledger accounting. Each test runs in its own temp directory with its own policy and ledger.

## License

MIT
