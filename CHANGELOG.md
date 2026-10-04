# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-04

### Added

- Claude Code plugin with PreToolUse, PostToolUse and PostToolUseFailure hooks for MCP tools that move money.
- Per-currency per-call, per-session and daily caps, a confirm-above threshold, payee allow and deny lists, currency aliases (stablecoins count as USD) and a dry-run mode.
- Built-in extractor rules for capline-mcp, Stripe, PayPal, wallet tools (AgentKit, CDP, EVM, Solana), x402 and a generic payment-name fallback, plus user-defined rules.
- Global policy (`~/.claude/leash.json`) and per-project policy (`.leash.json`) that can only tighten the global one unless `projectCanLoosen` is set.
- Append-only JSONL ledger with lock-free reserve-then-check, so parallel sessions cannot jointly overspend a cap.
- Fail-closed behavior: internal errors, unparseable or invalid policy files, and Node failing to start all escalate to the user.
- Tamper guard that asks before Bash, Edit, Write, MultiEdit or NotebookEdit touch the policy or ledger.
- `/leash:status`, `/leash:ledger` and `/leash:set` commands, and a CLI (`status`, `ledger`, `policy`, `set`, `add`, `remove`, `check`).
- `fakepay` demo MCP server and `examples/demo/demo.sh`.

[Unreleased]: https://github.com/agnij-dutta/cc-leash/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/agnij-dutta/cc-leash/releases/tag/v0.1.0
