# Lazy Loading CLI

The plugin registers the lazy-loaded root commands `openclaw lazy-loading` and
the short alias `openclaw lazy`. The command surface calls the same feature
contract handlers as the other plugin surfaces; it does not edit OpenClaw
configuration directly.

```sh
openclaw lazy status
openclaw lazy status --agent researcher --json
openclaw lazy enable --agent researcher
openclaw lazy disable --all
openclaw lazy mode set plugin --agent researcher
openclaw lazy mode set native
openclaw lazy core list --agent researcher
openclaw lazy core add read write --agent researcher
openclaw lazy core remove write --agent researcher
openclaw lazy never list --agent researcher
openclaw lazy never add dangerous_tool --agent researcher
openclaw lazy never remove dangerous_tool --agent researcher
openclaw lazy catalog --agent researcher
openclaw lazy catalog --agent researcher --sort size --json
```

`enable` and `disable` require exactly one of `--agent <id>` or `--all`.
`mode set` accepts `native`, `plugin`, or `off`; omitting `--agent` changes
the plugin default. `core` and `never` require an agent. Removing a tool from
either class returns it to `deferred` (the contract's neutral class).

`status --json` returns the stable `status` operation result, including the
contract/plugin versions, configuration validity, per-agent effective mode,
harness, tool counts, schema sizes, notes, and available metrics. `catalog
--json` returns the `catalog` operation result with classified tools, schema
bytes/tokens, totals, and configured tools missing from the known inventory.
JSON is pretty-printed; consumers should rely on the feature contract schema,
not on key ordering or human-readable output.

Catalog inventories are populated from observed effective tools or supplied
through the contract. If the plugin has not observed an agent's tool inventory,
`catalog` reports `available: false`; it does not invent a catalog. `status`
metrics are omitted until metrics exist. Commands for planned operations such
as `stats`, `bench`, and `reset` are not exposed by this CLI release.
