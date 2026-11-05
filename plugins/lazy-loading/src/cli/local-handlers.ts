import { loadConfig, mutateConfigFile } from "openclaw/plugin-sdk/config-runtime";
import { InventoryStore } from "../catalog/inventory.js";
import { createHandlers, type ServiceDeps } from "../service.js";
import { HostConfigStore } from "../state/config-store.js";
import { PLUGIN_VERSION } from "../version.js";
import type { LazyLoadingContract } from "../contract.js";
import type { FeatureHandlers } from "openclaw/plugin-sdk/feature-plugin";

let handlers: FeatureHandlers<LazyLoadingContract> | undefined;

/**
 * CLI metadata registration intentionally has no plugin runtime, so it cannot
 * receive setup-bound handlers. Build the same feature handlers on demand over
 * the host's public local config runtime; all operation behavior stays in
 * createHandlers and HostConfigStore.
 */
export function getLocalCliHandlers(): FeatureHandlers<LazyLoadingContract> {
  if (handlers) return handlers;

  const configRuntime = {
    current: () => loadConfig({ skipPluginValidation: true }),
    mutateConfigFile: (params: Parameters<typeof mutateConfigFile>[0]) => mutateConfigFile(params),
  };
  const inventory = new InventoryStore();
  const deps: ServiceDeps = {
    pluginVersion: PLUGIN_VERSION,
    configStore: new HostConfigStore(configRuntime),
    inventory,
    getHostConfig: configRuntime.current,
  };
  handlers = createHandlers(deps);
  return handlers;
}
