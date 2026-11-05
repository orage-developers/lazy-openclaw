export type SessionTool = { name: string; origin: "loaded" | "predicted"; activatedAt: number; lastUsedAt?: number; turnsRemaining: number };
export type SessionState = { sessionKey: string; agentId?: string; stickyTurns: number; tools: SessionTool[]; misses: { tool: string; at: number }[] };

/** In-memory, process-local state. A gateway restart intentionally starts clean. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  get(key: string, stickyTurns = 0, agentId?: string): SessionState {
    return this.sessions.get(key) ?? { sessionKey: key, ...(agentId ? { agentId } : {}), stickyTurns, tools: [], misses: [] };
  }
  activate(key: string, agentId: string | undefined, names: readonly string[], stickyTurns: number, at: number, origin: SessionTool["origin"] = "loaded"): SessionState {
    const state = this.get(key, stickyTurns, agentId);
    state.agentId = agentId ?? state.agentId;
    state.stickyTurns = stickyTurns;
    for (const name of names) {
      const found = state.tools.find((tool) => tool.name === name);
      if (found) { found.turnsRemaining = stickyTurns; found.lastUsedAt = at; }
      else state.tools.push({ name, origin, activatedAt: at, turnsRemaining: stickyTurns });
    }
    state.tools.sort((a, b) => a.name.localeCompare(b.name));
    this.sessions.set(key, state);
    return state;
  }
  advance(key: string, stickyTurns: number, agentId?: string): SessionState {
    const state = this.get(key, stickyTurns, agentId);
    state.stickyTurns = stickyTurns;
    const current = { ...state, tools: state.tools.map((tool) => ({ ...tool })), misses: state.misses.slice() };
    state.tools = state.tools.flatMap((tool) => tool.turnsRemaining <= 1 ? [] : [{ ...tool, turnsRemaining: tool.turnsRemaining - 1 }]);
    this.sessions.set(key, state);
    return current;
  }
  /** Revalidate activations against current classification, not cached permissions. */
  retain(key: string, agentId: string, eligible: ReadonlySet<string>): void {
    const state = this.sessions.get(key);
    if (!state) return;
    if (state.agentId !== agentId) { this.sessions.delete(key); return; }
    state.tools = state.tools.filter((tool) => eligible.has(tool.name));
  }
  clear(sessionKey?: string, agentId?: string): number {
    if (sessionKey) return this.sessions.delete(sessionKey) ? 1 : 0;
    let cleared = 0;
    for (const [key, state] of this.sessions) if (!agentId || state.agentId === agentId) { this.sessions.delete(key); cleared++; }
    return cleared;
  }
}
