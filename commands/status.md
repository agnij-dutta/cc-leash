---
description: Show spend today vs your leash caps, plus recent allow/deny decisions
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

## Leash status

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/leash.mjs" status`

Present the status above to the user as-is in a code block. Then, in at most two short sentences, call out anything notable: a currency near or over its daily cap, recent denials, pending holds, or calls with an unknown amount. Do not change any policy.
