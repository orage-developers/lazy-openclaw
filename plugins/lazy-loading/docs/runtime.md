# Runtime semantics and MVP boundaries

`plugin` mode uses OpenClaw 2026.9.5 `before_prompt_build` and returns a
deterministically sorted `toolsAllow` list. The hook narrows the existing
host-approved set; it does not grant access. Codex and CLI runtimes are skipped,
as is an unknown harness. The baseline documents why: Codex rejects restrictive
`toolsAllow` values.

OpenClaw evaluates this hook when it builds an attempt's prompt, not between
model/tool/model steps. A tool selected by `lazy_load_tools` therefore becomes
callable on the **next run/turn**, never later in the current run. In plugin
mode the tool search is intentionally a bounded lexical match / exact-name MVP;
the predictor ranks current-message intent when enabled.

Session state is held in memory for the gateway process. It is isolated by
OpenClaw's `sessionKey`, expires by configured sticky turns, and can be cleared
through `reset-session`. It does not survive gateway restart. State reset at a
session's end is not wired to a lifecycle hook yet; use explicit reset or allow
the in-memory entry to remain until process exit.

The tool catalog is not fetched from a privileged gateway API. It is based on
tools observed in `llm_input` or explicitly supplied by a caller. An observed
snapshot represents the effective tools visible in that run, but the plugin
cannot prove it is a complete inventory for every future runtime/configuration.
If inventory is unavailable, `toolsAllow` is omitted (fail open) and loading
fails with a diagnostic rather than pretending an empty catalog is complete.
When present, the list still only removes tools from the host's policy-approved
surface.
