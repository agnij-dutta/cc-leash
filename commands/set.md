---
description: Change your leash spending policy (caps, payee lists, confirmation threshold, dry-run)
argument-hint: "[what to change, e.g. 'daily USD cap to 500']"
disable-model-invocation: true
---

## Current effective policy

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/leash.mjs" policy`

## Your job

Help the user edit their leash spending policy. The user's request (may be empty): $ARGUMENTS

Editable keys (dotted paths):

- `limits.<CUR>.perCall`, `limits.<CUR>.perSession`, `limits.<CUR>.daily`, `limits.<CUR>.confirmAbove` (numbers in major units, e.g. dollars; `<CUR>` like USD, EUR, ETH, or `*` for any other currency)
- `payees.allow`, `payees.deny` (lists of case-insensitive glob patterns, e.g. `acme-*`)
- `dryRun` (true = log what would happen, block nothing), `enabled`
- `unknownAmount`, `unknownCurrency`, `unlistedCurrency` (`ask` | `deny` | `allow`)
- `autoApprove` (true = in-policy calls skip the normal permission prompt)
- `aliases.<CUR>` (count one currency against another's caps, e.g. USDC -> USD)

If the request is empty or ambiguous, ask what they want to change first. Show the exact change you will make, then apply it by running the leash CLI with the Bash tool, one change per command:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/leash.mjs" set limits.USD.daily 500
node "${CLAUDE_PLUGIN_ROOT}/scripts/leash.mjs" add payees.deny "*@sketchy.example"
node "${CLAUDE_PLUGIN_ROOT}/scripts/leash.mjs" remove payees.allow acme
node "${CLAUDE_PLUGIN_ROOT}/scripts/leash.mjs" set dryRun true
```

To remove a cap, set it to `null` (for example `set limits.USD.confirmAbove null`). To go back to the built-in default, use `unset` (for example `set limits.USD.confirmAbove unset`). The CLI refuses to save a value leash would reject, and prints why.

Edits go to the global policy (`~/.claude/leash.json`) by default. Add `--project` to write the project's `.leash.json` instead; a project policy can only tighten the global one unless the global policy sets `projectCanLoosen: true`.

leash asks the user to confirm any command that changes its own policy. That is expected: never try to work around it, and never raise a limit the user did not explicitly ask to raise. Finish by running `node "${CLAUDE_PLUGIN_ROOT}/scripts/leash.mjs" status` and showing the result.
