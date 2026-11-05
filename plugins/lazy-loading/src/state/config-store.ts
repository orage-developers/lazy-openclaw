import { LazyLoadingError } from "../errors.js";
import type { RawConfig } from "../config/schema.js";

/** Where the persisted plugin config lives. Async because the host store is. */
export interface ConfigStore {
  /** Raw `plugins.entries["lazy-loading"].config`, or undefined when absent. */
  read(): Promise<unknown>;
  /** Apply `mutate` to a draft of the raw plugin config and persist the result. */
  update(mutate: (draft: RawConfig) => void): Promise<void>;
}

/** In-memory store for tests and for hosts without write access. */
export class MemoryConfigStore implements ConfigStore {
  private value: unknown;

  constructor(initial?: unknown) {
    this.value = initial === undefined ? undefined : structuredClone(initial);
  }

  async read(): Promise<unknown> {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }

  async update(mutate: (draft: RawConfig) => void): Promise<void> {
    const draft = (this.value === undefined ? {} : structuredClone(this.value)) as RawConfig;
    mutate(draft);
    this.value = draft;
  }
}

type HostConfigRuntime = {
  current(): unknown;
  mutateConfigFile(params: {
    afterWrite: { mode: "auto" } | { mode: "restart"; reason: string } | { mode: "none"; reason: string };
    mutate: (draft: Record<string, unknown>) => void | Promise<void>;
  }): Promise<unknown>;
};

const PLUGIN_ID = "lazy-loading";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function pluginConfigOf(hostConfig: unknown): unknown {
  const plugins = isRecord(hostConfig) ? hostConfig.plugins : undefined;
  const entries = isRecord(plugins) ? plugins.entries : undefined;
  const entry = isRecord(entries) ? entries[PLUGIN_ID] : undefined;
  return isRecord(entry) ? entry.config : undefined;
}

/**
 * Config store backed by the host (`api.runtime.config`): reads the live runtime
 * snapshot and persists edits with `mutateConfigFile`, letting the gateway reload
 * planner decide how to apply them (`afterWrite: auto`).
 */
export class HostConfigStore implements ConfigStore {
  constructor(private readonly config: HostConfigRuntime) {}

  async read(): Promise<unknown> {
    const value = pluginConfigOf(this.config.current());
    return value === undefined ? undefined : structuredClone(value);
  }

  async update(mutate: (draft: RawConfig) => void): Promise<void> {
    try {
      await this.config.mutateConfigFile({
        afterWrite: { mode: "auto" },
        mutate(hostDraft) {
          const plugins = (isRecord(hostDraft.plugins) ? hostDraft.plugins : (hostDraft.plugins = {})) as Json;
          const entries = (isRecord(plugins.entries) ? plugins.entries : (plugins.entries = {})) as Json;
          const entry = (isRecord(entries[PLUGIN_ID]) ? entries[PLUGIN_ID] : (entries[PLUGIN_ID] = {})) as Json;
          const draft = (isRecord(entry.config) ? entry.config : (entry.config = {})) as RawConfig;
          mutate(draft);
        },
      });
    } catch (cause) {
      if (cause instanceof LazyLoadingError) throw cause;
      throw new LazyLoadingError("CONFIG_WRITE_FAILED", `could not persist the plugin config: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  }
}

export { pluginConfigOf };
