# Feature contract (v1)

The CLI, the `/lazy` slash command and the Control UI talk to the plugin only
through this contract (`src/contract.ts`, built with `defineFeatureContract`).
Schemas are TypeBox; every payload is bounded JSON validated by the OpenClaw
feature runtime on input and on output.

Contract version: `1` (`CONTRACT_VERSION`, returned by `status.contractVersion`).

## Transport

- Each operation is registered as a plugin **session action** whose id is the
  operation id. Queries require scope `operator.read`, actions `operator.write`.
- Browser code uses `createFeatureClient(contract, host)`:
  `feature.invoke("status", {})`, `feature.on("config-changed", cb)`,
  `feature.watch("status", {}, { events: ["config-changed"], onChange, onError })`.
- Import the contract from `src/contract.ts` (browser safe: TypeBox + SDK contract only).
- Operation and event ids must be lowercase (`[a-z][a-z0-9._-]*`) per the SDK, so
  the camelCase names in PLAN.md F-10 are kebab-case ids here:

| PLAN.md name | Contract id |
| --- | --- |
| `status`, `catalog`, `stats` | same |
| `sessionState` | `session-state` |
| `setMode` | `set-mode` |
| `setAgentEnabled` | `set-agent-enabled` |
| `setToolClass` | `set-tool-class` |
| `resetSession` | `reset-session` |
| `runBenchmark` | `run-benchmark` |
| `configChanged`, `statsUpdated`, `toolsLoaded` | `config-changed`, `stats-updated`, `tools-loaded` |
| (added) | `benchmark-progress` |

## Stability rules

1. Operation ids, event ids and existing fields do not change within a contract
   version. New fields are added as optional.
2. A breaking change bumps `CONTRACT_VERSION`; clients should check
   `status.contractVersion` once and refuse to run against a higher major.
3. Unimplemented operations keep their final schemas and fail with
   `NOT_IMPLEMENTED` (below), so clients can be written against them now.

## Errors

- **Validation** (host-owned): `{ ok: false, code: "INVALID_INPUT" | "INVALID_OUTPUT", error }`.
- **Domain errors** (plugin-owned): the SDK only structures its own validation
  errors, so domain failures reach callers as generic errors whose message starts
  with `[lazy-loading:<CODE>] `. Use `parseErrorCode(message)` from `src/errors.ts`.

| Code | Meaning |
| --- | --- |
| `NOT_IMPLEMENTED` | Operation declared but not built yet; the message names the planned task, e.g. `[lazy-loading:NOT_IMPLEMENTED] stats is not implemented yet (planned: F-09)`. |
| `CONFIG_INVALID` | Persisted plugin config fails validation; fix it before running actions. `status` still works and lists `configIssues`. |
| `CONFIG_WRITE_FAILED` | The host refused or failed the config write. |
| `INVALID_ARGUMENT` | Well-formed but meaningless input, e.g. changing the class of `lazy_load_tools`. |

## Queries

### `status` (implemented)

Input `{ agentId? }`. Output:

```json
{
  "contractVersion": 1,
  "pluginVersion": "0.1.0",
  "enabled": true,
  "defaultMode": "native",
  "configValid": true,
  "configIssues": [],
  "agents": [
    {
      "agentId": "coordinator",
      "enabled": true,
      "mode": "plugin",
      "effectiveMode": "off",
      "effectiveReason": "codex-native-deferral",
      "harness": "codex",
      "hasOverride": false,
      "counts": { "core": 9, "deferred": 46, "never": 0 },
      "schema": { "totalBytes": 106483, "visibleBytes": 20171, "savingPct": 81 },
      "notes": ["Runs on the Codex app-server, which already defers OpenClaw tool schemas and rejects toolsAllow; mode 'plugin' has no effect."]
    }
  ]
}
```

- `agents` = agents in the plugin config, in the host config (`agents.entries`) and
  with an observed inventory; sorted by id.
- `mode` is what is configured; `effectiveMode`/`effectiveReason` is what applies
  after harness resolution. Reasons: `configured`, `plugin-disabled`,
  `agent-disabled`, `codex-native-deferral`, `cli-backend`, `harness-unknown`.
  UIs should show `effectiveMode` and surface `notes`.
- `harness`: `embedded | codex | copilot | cli | unknown`, resolved from config
  (`src/harness.ts`); `openai/*` with the codex plugin enabled resolves to `codex`.
- `counts`/`schema` are `null` until an inventory exists for the agent.
- While the config is invalid: `configValid: false`, `enabled: false`, all agents
  `effectiveMode: "off"`.
- `metrics` (optional per agent) appears once F-09 lands.

### `catalog` (implemented)

Input `{ agentId, sort?: "class"|"name"|"size", classes?: ("core"|"deferred"|"never")[], inventory?: Tool[] }`.
Output (`CatalogSchema`): `{ agentId, available, origin?, capturedAt?, entries[], summary, missing }`.

- `entries[]`: `{ name, class, reason, source, pluginId?, directOnly, description, signature, schemaBytes, schemaTokens }`.
  `reason` is `config-never | config-core | direct-only | loader | default`.
  Precedence: the loader tool and host direct-only tools are always `core`, then
  the agent's `never`, then its `core`, otherwise `deferred`.
- `schemaBytes` = UTF-8 size of `{ name, description, parameters }`; `schemaTokens` = bytes / 4 rounded up
  (the estimate used in `docs/baseline.md`).
- `summary`: `total/core/deferred/never` each `{ count, bytes, tokens }`, plus
  `savingPct` (share of bytes kept out of the initial prompt). It covers all
  classes even when `classes` filters `entries`.
- `missing`: configured `core`/`never` names absent from the inventory.
- Ordering is deterministic (class order core, deferred, never; then name; `size`
  sorts by bytes descending). Input order never matters.
- **Inventory source.** The plugin cannot ask the gateway for an agent's effective
  tools (`tools.catalog`/`tools.effective` are operator methods, not available to
  external plugins). It uses, in order: tools supplied in `inventory` (origin
  `provided`; callers with operator access can pass `tools.effective` entries and
  the plugin remembers them), or tools observed on `llm_input` (origin
  `observed-run`, in-memory, per agent). Until one exists: `available: false`.
  The `llm_input` observer needs
  `plugins.entries.lazy-loading.hooks.allowConversationAccess: true`; without it
  the host logs `typed hook "llm_input" blocked` and only `provided` works.

### `stats` (stub, F-09)

Input `{ agentId?, sinceMs?, untilMs? }`. Output `{ agentId?, sinceMs, untilMs,
totals: { turns, loads, misses, schemaBytesSaved }, byMode[], byAgent[] }` where
`byMode[]` items are `{ mode, turns, ttftP50Ms?, ttftP95Ms?, avgVisibleTools?, avgSchemaBytes? }`.

### `session-state` (stub, F-06)

Input `{ sessionKey }`. Output `{ sessionKey, agentId?, stickyTurns, tools[], misses[] }`,
`tools[]` items `{ name, origin: "loaded"|"predicted", activatedAt, lastUsedAt?, turnsRemaining }`.

## Actions

### `set-mode` (implemented)

Input `{ mode: "native"|"plugin"|"off", agentId? }`; without `agentId` it sets the
plugin `defaultMode`. Output `{ changed, scope: "default"|"agent", agentId?, mode,
previousMode, notes[] }`. No write and no event when nothing changes; an inherited
value never creates an agent entry. Notes warn when the agent's runtime cannot
honour the mode, and that `native` drives the global `tools.toolSearch`.

### `set-agent-enabled` (implemented)

Input `{ agentId, enabled }`. Output `{ changed, agentId, enabled, previousEnabled, notes[] }`.

### `set-tool-class` (implemented)

Input `{ agentId, tool, class: "core"|"deferred"|"never" }`. Output `{ changed,
agentId, tool, class, previousClass, core[], never[] }` (the agent's resulting
lists). Only the lists that change are written to the agent entry; writing a list
materializes the inherited names it contains, because an agent list replaces the
defaults. `lazy_load_tools` cannot be changed (`INVALID_ARGUMENT`).

### `reset-session` (stub, F-06)

Input `{ sessionKey? , agentId? }`. Output `{ cleared }`.

### `run-benchmark` (stub, F-11)

Input `{ agentId, prompt, runs?: 1-10 (3), modes?: Mode[] (["off","plugin"]), runId? }`.
Long-running: emits `benchmark-progress` and returns `{ runId, agentId, startedAt,
finishedAt, runs[], summary[] }` when done. `runId` is client-chosen so a UI can
correlate events before the call returns.

## Events

Delivered to operator clients with scope `operator.read`. After any event, clients
re-query rather than patch local state.

| Event | Payload |
| --- | --- |
| `config-changed` | `{ change: "mode"\|"enabled"\|"toolClass", scope: "default"\|"agent", agentId?, at }` |
| `stats-updated` | `{ agentId?, at }` (F-09) |
| `tools-loaded` | `{ sessionKey, agentId?, tools[], origin: "loaded"\|"predicted", at }` (F-05/F-07) |
| `benchmark-progress` | `{ runId, agentId, state: "started"\|"running"\|"completed"\|"failed", completedRuns, totalRuns, error?, at }` (F-11) |

`at` is epoch milliseconds. Emission is best-effort and silent before the gateway
service has started.

## Configuration persistence

Actions edit `plugins.entries["lazy-loading"].config` through
`api.runtime.config.mutateConfigFile({ afterWrite: { mode: "auto" } })`
(`src/state/config-store.ts`); the gateway decides hot reload versus restart.
Reads use the live runtime snapshot. Setting `native` mode does not yet write
`tools.toolSearch` (F-08).
