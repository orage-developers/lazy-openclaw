# Runtime semantics and MVP boundaries

`plugin` mode uses OpenClaw 2026.9.5 `before_prompt_build` and returns a
deterministically sorted `toolsAllow` list. The hook narrows the existing
host-approved set; it does not grant access. Codex and CLI runtimes are skipped,
as is an unknown harness. The baseline documents why: Codex rejects restrictive
`toolsAllow` values.

Runtime detection uses the actual turn model and trusted session binding before
the agent's configured primary. Each registration owns its config, inventory and
session state: another registry generation cannot overwrite an active hook's
dependencies. The SDK's call-path `api.config` takes precedence over the
process-global runtime config snapshot.

OpenClaw evaluates this hook when it builds an attempt's prompt, not between
model/tool/model steps. A tool selected by `lazy_load_tools` therefore becomes
callable on the **next run/turn**, never later in the current run. In plugin
mode the tool search is intentionally a bounded lexical match / exact-name MVP;
the predictor ranks current-message intent when enabled.

Session state is held in memory for the gateway process. It is isolated by
OpenClaw's `sessionKey`, expires by configured sticky turns, and can be cleared
through `reset-session` or the host's `session_end` hook. It does not survive
gateway restart. Activations are revalidated against current classification on
each turn; moving a tool to `never` removes an existing activation.

The tool catalog is not fetched from a privileged gateway API. It is based on
tools observed in `llm_input` or explicitly supplied by a caller. An observed
snapshot represents the effective tools visible in that run, but the plugin
cannot prove it is a complete inventory for every future runtime/configuration.
Restricted observations are merged rather than replacing deferred descriptors;
an explicitly provided inventory replaces the previous snapshot.

For a known embedded runtime, a cold start can restrict to configured core names
plus the loader without an inventory: the host intersects those names with its
approved surface. This is schema narrowing, **not proof of complete discovery**.
OpenClaw 2026.9.5 exposes `llm_input` only after filtering, so a process that has
never observed a full catalog cannot search tools it has already hidden. The
loader reports that boundary instead of inventing tool names or schemas. Full
discovery needs an earlier complete observation or trusted supplied inventory.
The native host tool-search route is the alternative for same-run discovery;
automatic configuration of that route remains unfinished (F-08).
