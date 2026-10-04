# Security policy

cc-leash puts spending limits on money-moving tool calls, so a bypass is a real bug. Thank you for reporting one.

## Reporting a vulnerability

Please report privately through GitHub: on the repository page, go to **Security > Report a vulnerability** ([GitHub's guide](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)). Don't open a public issue or PR for a vulnerability.

Include the cc-leash version or commit, your Claude Code version, the policy file(s) involved, and the hook input that triggers the problem (a `test/fixtures`-style JSON is ideal). You can expect an acknowledgement within 7 days. Once a fix ships, the advisory is published with credit, unless you'd rather stay anonymous.

Supported versions: the latest release on `main`.

## What cc-leash is

A client-side guard rail. It runs as a Claude Code hook on your machine and checks MCP tool calls before they run. It defends against **the model** doing something you didn't intend: a prompt injection, a misread instruction, a runaway loop, or splitting a payment to dodge a cap. It also defends against **an untrusted repository** loosening your limits through a `.leash.json`.

## In scope

Report anything that lets a money-moving MCP call matching a rule run when the policy says it should be denied or asked about. For example:

- a payment over a cap, or to a denied or non-allowlisted payee, that is allowed
- a project `.leash.json` that loosens the global policy without `projectCanLoosen`
- a hook error, malformed input or malformed policy that results in an allow (fail open)
- concurrent sessions together spending more than a cap
- amount or currency extraction that understates the amount (for example a minor-unit mistake)
- the tool-name normalization or read-only exclusion letting a money-moving built-in tool through unchecked

## Known non-goals and limitations

These are by design and are documented in the README. Reports about them are welcome as feature ideas, not vulnerabilities.

- **The curl bypass.** leash sees MCP tool calls only. If Claude can reach a payment API another way (`curl https://api.stripe.com/... -u $STRIPE_KEY` from Bash, a Python script, an SDK in the project), leash never sees it. The mitigation is operational: keep payment credentials inside the MCP server's own process environment, not in your shell, `.env` files Claude can read, or the project. Claude Code permission rules that deny `Bash(curl:*)` and similar help, but they are not a sandbox.
- **Local compromise.** Anyone, or any process, that can write to your home directory can edit `~/.claude/leash.json`, the ledger, or Claude Code's settings to disable the plugin. leash is not a defense against malware or another user on the machine.
- **The tamper guard is best-effort.** Asking before Bash or edit tools touch the policy or ledger catches the obvious paths, not every way a shell command can write a file. It also does not watch Claude Code's own settings, where the plugin can be disabled. Read permission prompts before approving.
- **Tool input is trusted.** leash limits what a call's arguments say. A malicious or buggy MCP server that charges a different amount than its arguments describe is out of scope. Pick payment servers you trust.
- **Unmatched tools.** A money-moving tool whose name matches no rule is not checked. Coverage gaps in built-in rules for popular payment servers are in scope as bugs; arbitrary custom tool names are not.
- **Timeouts.** A PreToolUse command hook that exceeds its timeout (15 s for leash) renders no decision, and the call falls back to Claude Code's normal permission flow ([docs](https://code.claude.com/docs/en/hooks)). leash keeps the hot path small, but a very large ledger or a slow disk could exceed it.
- **Hard guarantees.** For limits that must hold even if the machine is compromised, enforce them where the money is: on-chain mandates (for example [Capline](https://github.com/agnij-dutta/capline)), card spending controls, or provider-side restricted API keys.
