![Plugin logo](./public/plugin-logo.png)

[![CI](https://github.com/orage-developers/lazy-openclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/orage-developers/lazy-openclaw/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that makes agents load tools **only on demand**.

Every tool schema sent with a request makes the prompt bigger and the first token slower. Agents with large catalogs (`tools.profile: "full"`, MCP servers, Composio, custom plugins) can spend most of their time-to-first-token reading tools they never call. This plugin keeps a small, stable set of core tools visible and loads the rest only when the agent needs them.

**Goal:** cut time-to-first-token from ~40–50 s to ~10 s or less on simple tasks.

> Status: early development. See [PLAN.md](PLAN.md) for the roadmap and task status.

## How it works

Each agent runs in one of three modes:

| Mode | What the model sees | How it gets more tools |
| --- | --- | --- |
| `plugin` | Core tools + predicted tools + tools already loaded in the session | Calls `lazy_load_tools` with a query or tool names |
| `native` | OpenClaw's built-in [Tool Search](https://docs.openclaw.ai/tools/tool-search), configured by this plugin | `tool_search` / `tool_describe` / `tool_call` |
| `off` | Default OpenClaw behavior | — |

Loaded tools stay visible for a few turns ("sticky") so the tool list stays stable and prompt caching keeps working. An intent predictor preloads tools that the current message is likely to need.

## Requirements

- OpenClaw `2026.9.5` or later (plugin APIs are experimental; the plugin pins the host version it is tested against).
- Node.js 24.16+.
- For the Control UI tab: **Settings → Labs → Custom plugin UI** enabled, and the Control UI opened over HTTPS or a loopback URL.

## Install

```bash
git clone https://github.com/orage-developers/lazy-openclaw.git
cd lazy-openclaw/plugins/lazy-loading
npm ci && npm run build
openclaw plugins install .
```

## Usage

### CLI

```bash
openclaw lazy-loading status [--agent <id>] [--json]
openclaw lazy-loading enable|disable (--agent <id> | --all)
openclaw lazy-loading mode set <native|plugin|off> [--agent <id>]
openclaw lazy-loading core list|add|remove --agent <id> [tool...]
openclaw lazy-loading never list|add|remove --agent <id> [tool...]
openclaw lazy-loading catalog --agent <id> [--json]
openclaw lazy-loading stats [--agent <id>] [--since 24h]
openclaw lazy-loading bench --agent <id> --prompt "..." [--runs 3]
openclaw lazy-loading reset --session <key> | --agent <id>
```

In chat: `/lazy`, `/lazy load <tool|query>`, `/lazy reset`.

### Control UI

Open the **Lazy Loading** tab in the sidebar to see time-to-first-token before and after, manage modes per agent, classify tools as core / deferred / never, inspect loaded tools per session and run benchmarks.

### Configuration

```json5
plugins.entries["lazy-loading"].config = {
  enabled: true,
  defaultMode: "plugin",
  agents: {
    developer: {
      mode: "plugin",
      core: ["read", "write", "edit", "apply_patch"],
      never: [],
      stickyTurns: 10,
      predict: true,
    },
  },
  predictor: { enabled: true, maxPredicted: 5 },
  metrics: { enabled: true, retentionDays: 14 },
}
```

## Repository layout

```
plugins/
  lazy-loading/      the plugin (backend, CLI, Control UI page)
.github/workflows/   CI and release pipelines
PLAN.md              roadmap split by Functionality, CLI and UI
```

## Development

```bash
cd plugins/lazy-loading
npm ci
npm run typecheck
npm run build
npm test
npm run validate
```

CI runs these steps on every push and pull request.

## Releases

Push a tag named `<plugin>-v<version>`, for example `lazy-loading-v0.1.0`. The version must match `plugins/<plugin>/package.json`. The release workflow verifies and packs the plugin, creates a GitHub release with the tarball and publishes to npm when the `NPM_TOKEN` secret is set.

## Contributing

See [CONTRIBUTORS.md](CONTRIBUTORS.md).

## License

[MIT](LICENSE.md) © 2026 Orage Developers
