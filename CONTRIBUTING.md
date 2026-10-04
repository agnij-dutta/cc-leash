# Contributing to cc-leash

Thanks for helping. cc-leash is a security control for real money, so the bar is: every change keeps the hook failing closed, and every new behavior has a test.

## Setup

Requires Node.js 18+ (CI runs 18, 20 and 22). There are no runtime dependencies; the dev tools (ESLint, Prettier, TypeScript for JSDoc checking) are devDependencies.

```bash
git clone https://github.com/agnij-dutta/cc-leash && cd cc-leash
npm ci
```

## Checks

| Command             | What it runs                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `npm test`          | `node --test test/*.test.mjs` (works without `npm ci`)                                    |
| `npm run lint`      | ESLint (flat config in `eslint.config.js`)                                                |
| `npm run format`    | Prettier, write. `npm run format:check` only checks                                       |
| `npm run typecheck` | `tsc` in strict mode over the JSDoc types (`jsconfig.json`)                               |
| `npm run check`     | All of the above, in the same order as CI                                                 |
| `npm run validate`  | `claude plugin validate` on the marketplace and plugin manifests (needs the `claude` CLI) |
| `npm run demo`      | The interactive fakepay demo (needs a logged-in `claude`)                                 |

There is no build step: the plugin runs the `.mjs` files directly.

To try your working copy inside Claude Code without installing it, run `claude --plugin-dir .` from the repo root (or `npm run demo`).

## Layout

```
.claude-plugin/       plugin.json and marketplace.json (plugin manifest)
hooks/hooks.json      PreToolUse / PostToolUse / PostToolUseFailure wiring
commands/             /leash:status, /leash:ledger, /leash:set
scripts/leash.mjs     CLI and hook entry point (stdin JSON in, JSON out)
scripts/lib/
  engine.mjs          allow / ask / deny decisions, settle and release
  policy.mjs          load, validate and merge global + project policy
  rules.mjs           built-in extractor rules, tool matching, amount parsing
  ledger.mjs          append-only JSONL ledger, holds, totals
examples/fakepay/     a zero-dependency fake payment MCP server
examples/demo/        demo.sh and the demo policy
test/                 node:test suites; fixtures/ are recorded hook payloads
```

## Adding an extractor rule for a new payment MCP

A rule tells leash that a tool moves money and where its amount, currency and payee are. Built-in rules live in `DEFAULT_RULES` in `scripts/lib/rules.mjs`.

1. **Find the real tool names and input shape.** Run Claude Code with the server connected and look at the tool list (`/mcp`), or read the server's tool schemas. Note which field holds the amount and whether it is in major units (`12.50`) or minor units (`1250`).
2. **Record a fixture.** Copy `test/fixtures/pre-fakepay-pay-15.json` to `test/fixtures/pre-<server>-<tool>.json` and replace `tool_name` and `tool_input` with a real call. Keep `"cwd": "__CWD__"`. Use made-up payees and ids, never real account numbers, emails or keys.
3. **Write the rule.** Add it to `DEFAULT_RULES` above the `generic` rule (first match wins):

   ```js
   {
     id: "acmebank",
     description: "Acme Bank MCP wires (amounts in cents)",
     match: "^mcp__.*acmebank.*__(create_wire|send_wire)$",
     amount: ["wire.amount_cents"],
     minorUnits: true,           // or scale: 100 when it's always cents
     currency: ["wire.currency", "=USD"],
     payee: ["wire.beneficiary.account_name"],
   },
   ```

   - `match` is tested case-insensitively against the tool name and its snake_case form. Anchor it and list the money-moving verbs explicitly rather than matching the whole server.
   - Use `exclude: READ_ONLY` if your `match` is broad enough to catch `get_`/`list_` tools.
   - A `=` path is a literal fallback, used only when no earlier path has a value. Only add `"=USD"` if the API really defaults to USD.
   - If the amount can't be found, leash asks the user. That is the safe default, so don't guess.

4. **Check the extraction** with no side effects:

   ```bash
   node scripts/leash.mjs check mcp__acmebank__create_wire "$(node -e 'console.log(JSON.stringify(require("./test/fixtures/pre-acmebank-create-wire.json").tool_input))')"
   ```

5. **Test it.** In `test/rules.test.mjs`, assert the tool matches your rule, and that the server's read-only tools (`get_wire`, `list_wires`) match nothing. In `test/hooks.test.mjs`, assert an over-cap call is denied with the right amount in the reason.
6. **Document it** in the "Which tools it watches" table in the README and in `CHANGELOG.md` under Unreleased.

Users can add the same rule to their own policy's `rules` list without a release; see the README.

## Rules for changes

- **Fail closed.** Anything leash can't parse or decide becomes an `ask`, never a silent allow. An error is never treated as "no payment".
- **Projects only tighten.** Any new policy key needs an explicit case in `tightenMerge` in `policy.mjs`; the default for project files is "ignored".
- **Validate new policy keys** in `validatePolicy`, with an error for a wrong type.
- **Ledger events are append-only** and one line per write. Don't add locks or rewrite the file.
- **Zero runtime dependencies.** Node built-ins only in `scripts/` and `examples/`.
- Comments explain why, not what. Public functions get a JSDoc comment.
- No em dashes in docs or messages.

## Pull requests

Keep PRs focused, run `npm run check`, and fill in the template. Add a line to `CHANGELOG.md` under Unreleased for anything user-visible.
