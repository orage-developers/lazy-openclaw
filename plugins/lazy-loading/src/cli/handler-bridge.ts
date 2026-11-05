import type { FeatureHandlers } from "openclaw/plugin-sdk/feature-plugin";
import type { LazyLoadingContract } from "../contract.js";

const handlersByKey = new WeakMap<object, FeatureHandlers<LazyLoadingContract>>();

/** Bind the feature's single handler set to the stable host config identity. */
export function bindCliHandlers(key: object, handlers: FeatureHandlers<LazyLoadingContract>): void {
  handlersByKey.set(key, handlers);
}

/** Resolve handlers only when a CLI command runs, after plugin setup. */
export function getCliHandlers(key: object): FeatureHandlers<LazyLoadingContract> {
  const handlers = handlersByKey.get(key);
  if (!handlers) {
    throw new Error("Lazy Loading CLI is not ready: feature handlers were not bound during plugin setup.");
  }
  return handlers;
}
