---
description: Show the leash spending ledger (every payment decision and settlement)
argument-hint: "[rows, default 25]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

## Leash ledger

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/leash.mjs" ledger $ARGUMENTS`

Show the ledger above to the user in a code block. Briefly summarize totals by currency and any denials. Do not edit the ledger.
