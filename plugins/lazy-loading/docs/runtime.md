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

## Real-provider verification (2026-11-05)

Commit `8af012b` was built, validated, installed and hot-reloaded in the live
Gateway. Regression tests: `npm test` passed 120/120; `npm run typecheck`,
`npm run build`, `npm run validate` and `git diff --check` passed.

Two isolated embedded runs used exactly `RETURN OK`, `openai/gpt-5.6-sol`, medium
reasoning, normal service tier, no fallback and no warm-up: one request per mode.
Both returned `OK`, had zero cache reads and left live configuration unchanged.

- Plugin completely disabled: 65 wire tool definitions, 117,901 bytes of tool
  JSON, 31,887 input tokens; client-observed TTFT 1,936 ms; host turn 6,380 ms.
- Plugin enabled after the fix: 9 wire tool definitions, 13,356 bytes of tool
  JSON, 12,287 input tokens; client-observed TTFT 1,529 ms; host turn 6,636 ms.

The observer measured monotonic elapsed time from the client WebSocket send
boundary to the first nonempty upstream `response.output_text.delta`, excluding
connection setup and metadata-only events. This includes network, reasoning and
client scheduling/instrumentation; it is not server-only inference latency.
The same observer passed offline SSE and WebSocket tests. One sample per mode
does not establish a stable or causal speedup; total turn duration did not fall.
The nine visible tools were `apply_patch`, `edit`, `exec`, `lazy_load_tools`, `ls`,
`message`, `process`, `read` and `write`. This verifies cold schema narrowing,
not complete cold-start tool discovery (see the limitation above).

Raw reports, wire counts, event timestamps, the measurement harness and its two
offline tests are under
`/tmp/opencode/sol56-medium-ttft-20261105-152118/`. No credentials, messages or
full request bodies were added to the repository. Reverting `8af012b` and
redeploying its predecessor removes this runtime correction without changing
the user's Gateway service or agent configuration.
