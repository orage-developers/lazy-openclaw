# F-00 spike: harness, tool-search scope and baseline

Host: OpenClaw `2026.9.5` (`ec9c1a1`). Measured read-only against the live setup
(`~/.openclaw`, 7 agents). No model request was issued for this spike: everything
below comes from docs, host source (`dist/`, `~/.openclaw/extensions/codex/dist`)
and from existing per-agent trajectory/rollout records (copied to a scratch
directory before reading). One validation run used an isolated config file via
`OPENCLAW_CONFIG_PATH`/`OPENCLAW_STATE_DIR`, never the live gateway.

## 1. Answers to the three open questions

### 1.1 Which harness does each agent use?

| Agent | Model | Effective runtime | Evidence |
| --- | --- | --- | --- |
| coordinator | `openai/gpt-5.6-luna` | **Codex app-server** | `session.started` carries a Codex `threadId`; rollouts in `agents/coordinator/agent/codex-home/sessions`; first-turn payload has `dynamic_tools` |
| researcher | `openai/gpt-5.6-luna` | **Codex app-server** | same |
| writer | `openai/gpt-5.6-luna` | **Codex app-server** | same |
| reviewer | `openai/gpt-5.6-luna` | **Codex app-server** | same |
| friday | `openai/gpt-5.6-terra` | **Codex app-server** | same (26 Codex threads) |
| developer | `openai/gpt-5.6-luna` | **Codex app-server** | same (8 Codex threads) |
| scout-local | `openrouter/z-ai/glm-5.3-flash` | **OpenClaw embedded runner** | no `threadId`, no `codex-home`, `modelApi: openai-completions` |

Why: the `codex` plugin is enabled and the `openai` provider has no authored
request overrides, so runtime `auto` lets Codex claim every
`openai/gpt-5.6-*` ref (`docs/concepts/agent-runtimes.md`, "Runtime selection").
The `openai/` prefix alone does not select Codex; the compatible route does.
The only explicit runtime pin in the user's config is
`agents.defaults.models["openai/gpt-6-astra"].agentRuntime.id = "openclaw"`;
early (2026-10-09/12) `developer` runs on `gpt-6-astra` therefore used the
embedded runner, but no agent uses that model any more. The harness is **not**
exposed on the hook context (`PluginHookAgentContext` has `modelProviderId`,
`modelId`, `trigger`, ...); see section 4.

### 1.2 Is `tools.toolSearch` overridable per agent?

**No, global only.** Verified three ways:

- `dist/zod-schema.agent-runtime-*.mjs`: `ToolSearchSchema` is referenced only
  in the global `ToolsSchema`; `AgentToolsSchema` (strict) only adds `codeMode`
  and `swarm` overrides.
- `resolveToolSearchConfig(config)` reads `config.tools.toolSearch` only.
- `openclaw config validate` on an isolated file with
  `agents.entries.coordinator.tools.toolSearch` fails with
  `Unrecognized key: "toolSearch"`.

Related facts: a provider runtime hook can force `toolSearchMode: "tools"` per
model (local inference does this), and Codex runs ignore `tools.toolSearch`
entirely (`docs/tools/tool-search.md`). So the `native` mode cannot be scoped to
one agent through config; it is a global switch that only affects agents whose
effective runtime is the embedded one.

### 1.3 Is `toolsAllow` recomputed between model calls inside one run?

**No. It is evaluated once per attempt (prompt build), not per model call.**
In `builtin-openclaw-*.mjs` the hook result feeds `applyPromptBuildToolsAllow`
once, before the prompt is submitted; it calls `session.setActiveToolsByName`.
The only re-application (`promptToolPolicy.refresh`) is triggered by a
permission-mode change. The model→tool→model loop inside the attempt reuses the
same active set.

Consequence for `plugin` mode: a tool activated by `lazy_load_tools` becomes
callable from the **next run** (next user turn or next attempt), not in the same
run. `lazy_load_tools` must say so in its output (F-05), and the F-07 predictor
matters more. `native` mode does not have this limit (its `tool_call` bridge
executes any catalogued tool immediately).

### 1.4 Hard constraint found while verifying: Codex rejects `toolsAllow`

`~/.openclaw/extensions/codex/dist/.setup/run-attempt-*.mjs` throws
`Codex app-server cannot enforce before_prompt_build toolsAllow; use the embedded or Copilot runtime`
for any restrictive (`!= ["*"]`) value. Returning `toolsAllow` for a Codex turn
does not just get ignored: it **fails the turn**. `plugin` mode must therefore
only return `toolsAllow` when it knows the run is not Codex (see section 4).

## 2. What Codex already does with tools

For Codex runs OpenClaw already ships its tools as thread-scoped dynamic tools
and marks all but a short list as `deferLoading: true` inside the `openclaw`
namespace (`createCodexDynamicToolSpecs`). Always-direct: `agents_list`,
`agents_wait`, `progress_card`, `sessions_spawn`, `sessions_yield`, plus
direct-only tools (`message`, `computer`, `heartbeat_respond`, ...). Codex-native
tool search loads the deferred schemas on demand.

So for the six Codex agents the "lazy loading of tool schemas" the plan wants is
**already partly implemented by the host**. The residual cost is the direct
tools, the per-tool listing in the prompt, and the Codex/OpenClaw system prompt.

## 3. Baseline

### 3.1 Static measurement (Codex `dynamic_tools` payload of the latest rollout per agent)

Bytes are `JSON.stringify` of each tool spec as sent to the Codex thread;
approximate tokens use bytes / 4.

| Agent | Tools | Direct | Deferred | Schema bytes (total) | Direct bytes | Deferred bytes | ~Tokens total | ~Tokens direct |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| coordinator | 56 | 9 | 47 | 107,997 | 20,171 | 87,826 | 27.0k | 5.0k |
| researcher | 55 | 9 | 46 | 106,483 | 20,171 | 86,312 | 26.6k | 5.0k |
| writer | 55 | 9 | 46 | 106,483 | 20,171 | 86,312 | 26.6k | 5.0k |
| reviewer | 55 | 9 | 46 | 106,483 | 20,171 | 86,312 | 26.6k | 5.0k |
| friday | 14 | 2 | 12 | 15,370 | 6,958 | 8,412 | 3.8k | 1.7k |
| developer | 9 | 0 | 9 | 4,461 | 0 | 4,461 | 1.1k | 0 |
| scout-local (embedded) | see note | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

Largest deferred schemas (coordinator): `automations` 14.4 kB, `browser` 9.5 kB,
`skill_workshop` 6.5 kB, `sessions` 4.3 kB, `dashboard` 4.1 kB, `nodes` 3.5 kB,
`image_generate` 2.8 kB, `mobile_ui` 2.6 kB. Largest direct: `sessions_spawn`
6.9 kB, `computer` 5.0 kB, `message` 3.4 kB. Tool counts include the
composio MCP wrapper `scout_hq_composio__composio_mcp` (0.6 kB) and the five
`scout_*` tools (0.3-0.8 kB each).

Note on `scout-local`: its only recorded run is a cron run with 7 tools
(`exec`, `process`, `edit`, `ls`, `read`, `apply_patch`, ...). A coordinator-like
interactive run on the embedded runner (heartbeat on `openrouter/z-ai/glm-5.3`)
exposed 51 tools. The trajectory recorder truncates embedded tool schemas
(`undefined:13` placeholders), so embedded schema bytes are not recoverable from
logs; assume the same ~100 kB class as the other `profile: "full"` agents when
the same policy applies. This is an estimate, not a measurement.

### 3.2 Prompt tokens (first turn, cold cache, tiny reply)

Codex `token_count` / trajectory `usage.input` of the last cold run per agent:

| Agent | Tools | Input tokens |
| --- | ---: | ---: |
| developer | 9-10 | 10.2k - 12.1k |
| friday | 13-14 | 12.2k - 13.6k |
| researcher / writer / reviewer | 55 | 25.3k |
| coordinator | 56 | 27.4k |

Input tokens grow by about 12-14k between the 14-tool and the 55-tool agents
while the deferred schemas are not sent in full (they alone would add ~23k).
Inference: roughly 0.3 k tokens per tool still reaches the prompt (tool listing
in the system prompt, direct specs); this is the part a plugin can still trim.
The remaining ~10k is the fixed system prompt / Codex base instructions
(`base_instructions` = 15.9 kB).

### 3.3 Latency (from `trajectory_runtime_events`)

There is no first-token timestamp in the stored logs. The closest recorded
quantities are `session.started -> model.completed` (whole turn) and
`prompt.submitted -> first tool.call`. Embedded `model_call_ended` hooks do expose
`timeToFirstByteMs` and `requestPayloadBytes`, which F-09 should use for the
embedded runner; the Codex path does not emit them.

| Group | n | Turn time p50 | min - max |
| --- | ---: | ---: | --- |
| Codex, 55-56 tools, trivial prompt (coordinator/researcher/writer/reviewer) | 4 | 8.9 s | 4.9 - 11.9 s |
| Codex, 9-14 tools, trivial prompt (friday/developer, post 2026-10-12) | 9 | 4.2 s | 3.0 - 6.2 s |
| Codex, tool-using turns (friday/developer) | 10 | 64.7 s | 12.8 - 2421 s |
| Codex, first tool call after prompt submit | 10 | 7.2 s | 5.1 - 23.2 s |
| Embedded `openai/gpt-6-astra` (developer, 2026-10-09/12) | 5 | 4.9 s | 4.5 - 7.4 s |
| Embedded openrouter GLM-5.3-flash (scout-local, coordinator cron) | 2 | 10.9 / 26.3 s | |

Reading:

- For a trivial prompt, the full-profile Codex agents take ~5-12 s and the
  lean ones ~3-6 s. The tool surface explains at most a ~4-6 s gap, not
  40-50 s.
- The 40-50 s the user observes is consistent with **tool-using turns** (tens of
  seconds to minutes), where the cost is model reasoning plus tool round trips
  rather than tool schemas. First tool call arrives 5-23 s after the prompt.
- Therefore the realistic target for schema trimming is "full-profile agent
  trivial turn: ~9 s -> ~5 s", not a 5x improvement on every request. F-11 must
  measure end-to-end on representative tasks before promising <=10 s.

## 4. Consequences for the design

1. `plugin` mode **cannot work for six of the seven agents** (Codex rejects
   `toolsAllow`), and `native` mode does not apply to them either (Codex ignores
   `tools.toolSearch`). Both modes only have effect on the embedded runner:
   today that is `scout-local` and any model pinned to `agentRuntime.id: "openclaw"`.
2. For Codex agents the plugin can only (a) report that the host already defers
   schemas, (b) recommend static trimming (`tools.allow`/`tools.deny`,
   `alsoAllow` pruning, removing always-direct tools such as `computer`,
   `heartbeat_respond` when unused), and (c) measure. The contract exposes a
   per-agent `harness` and `effectiveMode` so UI/CLI show "off (Codex native
   deferral)" instead of a misleading "plugin".
3. Harness detection must not rely on the hook context. Resolution order for
   F-04: explicit `agents.{defaults,entries.<id>}.models[ref].agentRuntime.id`
   and `models.providers.<p>.agentRuntime.id`; then the session entry's
   `agentHarnessId` (`api.runtime.agent.session.getSessionEntry`); then provider
   heuristics (`openai/*` with the `codex` plugin enabled = assume Codex). When
   unsure, **do not return `toolsAllow`** (fail open to no restriction).
4. Same-run loading is impossible in `plugin` mode (section 1.3). Tool output and
   docs must state "available next turn", and `stickyTurns` is essential.
5. `native` is global-only: enabling it affects every embedded run. The plugin
   should expose it as a single global toggle with a per-agent *report*, and warn
   that per-agent `mode: "native"` only changes the plugin's bookkeeping.

## 5. Decision

- **Default mode: `native`** (`defaultMode: "native"`), implemented as "plugin
  manages `tools.toolSearch` (`directory` mode, global) and its core list".
  Rationale: it is the only mode that supports same-run loading, keeps the
  standard policy/approval path, and costs no extra tool. It is inert and safe on
  Codex agents (host ignores it).
- **`plugin` mode: opt-in, embedded-runtime agents only.** It is the only way to
  get per-agent granularity, but it needs the next-turn caveat and must hard-skip
  (return no `toolsAllow`) whenever the runtime is Codex or unknown.
- **`off`** remains the passthrough.
- **Effective mode** is computed per agent: Codex agents resolve to `off` with
  reason `codex-native-deferral`, whatever is configured. Enabling the plugin
  therefore never breaks a Codex turn.
- PLAN impact: F-04 gains a harness-detection step; F-05 output gains the
  "available next turn" semantics; F-08 must write the **global**
  `tools.toolSearch` (no per-agent override); F-11 should compare against the
  ~4-6 s trivial-turn gap measured here before claiming <=10 s on tool-using
  tasks. A new, small deliverable worth adding later: a "static trimming
  recommender" for Codex agents based on the catalog (largest direct tools).

## 6. Reproducing

All numbers come from read-only queries on copies of
`agents/<id>/agent/openclaw-agent.sqlite` (`trajectory_runtime_events`:
`session.started`, `prompt.submitted`, `tool.call`, `model.completed`,
`usage`) and the first `session_meta` line of the newest Codex rollout
(`agents/<id>/agent/codex-home/sessions/**/rollout-*.jsonl`, field
`dynamic_tools`). Re-run after upgrading OpenClaw, because the Codex namespace
and the deferral list are host internals.
