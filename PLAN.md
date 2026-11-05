# Plan: plugin `lazy-loading` para OpenClaw

Objetivo: que cualquier agente de OpenClaw cargue las tools **solo bajo demanda**, reduciendo el prompt inicial (schemas de tools) y con ello el time-to-first-token (TTFT). Meta: pasar de ~40-50 s a ≤10 s en tareas simples.

Host objetivo: OpenClaw `2026.9.5` (APIs de plugins experimentales: fijar versión en `openclaw.compat.pluginApi`).

---

## Contexto técnico (verificado en docs locales de OpenClaw 2026.9.5)

| Pieza del host | Uso en el plugin |
| --- | --- |
| `tools.toolSearch` (modos `code` / `tools` / `directory`) | Mecanismo nativo de carga diferida. El plugin puede activarlo y configurarlo por agente en lugar de reimplementarlo. No aplica a runs con harness Codex. |
| Hook `before_prompt_build` → `toolsAllow` | Estrecha la superficie de tools por turno (embedded runner y Copilot). Codex app-server **rechaza** valores restrictivos. |
| Hook `before_tool_call` | Observar llamadas, registrar "misses" y métricas. No puede añadir tools ocultas. |
| `api.registerTool` (+ `catalogMode: "direct-only"`) | Tool propia `lazy_load_tools` siempre visible. |
| `api.registerCli` con `descriptors` | Comandos `openclaw lazy-loading ...` con registro perezoso. |
| `api.registerCommand` | Slash command `/lazy` dentro del chat. |
| Feature plugin: `defineFeatureContract`, `defineFeaturePlugin`, `defineControlUiPlugin` | Operaciones compartidas UI/CLI/tool y página nativa con `registerPage` + `registerNavigation`. |
| Labs → "Custom plugin UI" (`gateway.controlUi.experimental.customPlugins`) | Requisito para ver el tab "Lazy Loading". |

Setup actual del usuario: 7 agentes (`coordinator`, `researcher`, `writer`, `reviewer`, `friday`, `developer`, `scout-local`), `tools.profile: "full"`, muchas tools vía `alsoAllow` (scout_*, composio), plugin `codex` habilitado.

### Estrategia (dos modos por agente)

- **`native`**: el plugin gestiona `tools.toolSearch` (preferentemente modo `directory`) y su lista de tools core. Menos código, misma ruta de políticas/aprobaciones.
- **`plugin`**: el plugin calcula `toolsAllow` en cada turno = `core ∪ predichas ∪ activadas en la sesión`. El agente amplía su set llamando a `lazy_load_tools`. Útil si `native` no está disponible o no rinde.
- **`off`**: comportamiento por defecto de OpenClaw.

Principio: el set visible debe ser **estable** entre turnos (orden determinista, activaciones "sticky") para no romper el prompt cache.

---

## Functionality

### F-00 · Spike y medición base (bloquea todo)
- [x] Confirmar qué harness usa cada agente (embedded / Codex / Copilot) con los modelos `openai/gpt-5.6-*` y `openrouter/...`. Si es Codex, `toolsAllow` y `toolSearch` no aplican: documentar alternativa.
- [x] Confirmar si `tools.toolSearch` admite override por agente (`agents.entries.<id>.tools.toolSearch`) o solo global.
- [x] Confirmar si `toolsAllow` se recalcula entre llamadas al modelo dentro del mismo run o solo por turno de usuario (define si una tool cargada sirve en el mismo turno).
- [x] Medir baseline por agente: TTFT, nº de tools, bytes de schemas, tokens de prompt (Gateway con `--raw-stream`). _Hecho con logs existentes (trajectory/rollouts) y medición estática; sin `--raw-stream` ni TTFT real: ver `docs/baseline.md`._
- **Aceptación**: tabla baseline en `docs/baseline.md` y decisión de modo por defecto.

### F-01 · Scaffold del plugin
- [x] `openclaw plugins init lazy-loading --name "Lazy Loading" --type feature`.
- [x] `openclaw.plugin.json`: `id: "lazy-loading"`, `contracts.tools: ["lazy_load_tools"]`, `activation.onStartup: true`, `configSchema`.
- [x] `package.json` con `openclaw.compat.pluginApi` fijado a `2026.9.5`.
- **Aceptación**: `npm run build && npm run validate` pasan; `openclaw plugins install .` lo carga (verificado con perfil aislado `OPENCLAW_STATE_DIR`; el manifiesto se genera con `npm run build`).

### F-02 · Esquema de configuración
```json5
plugins.entries["lazy-loading"].config = {
  enabled: true,
  defaultMode: "plugin",            // "native" | "plugin" | "off"
  agents: {
    "<agentId>": {
      enabled: true,
      mode: "plugin",
      core: ["read", "write", "scout_ask_user"],   // siempre visibles
      never: [],                                    // nunca se cargan
      stickyTurns: 10,                              // turnos que una tool activada sigue visible
      predict: true
    }
  },
  predictor: { enabled: true, maxPredicted: 5, minScore: 0.3 },
  metrics: { enabled: true, retentionDays: 14 }
}
```
- [x] Validación con TypeBox; agentes sin entrada usan `defaultMode` y un `core` por defecto.
- **Aceptación**: config inválida falla en `openclaw plugins validate` con mensaje claro. _Nota: el host valida la forma (JSON Schema, `openclaw config validate`); las reglas semánticas (core∩never, ids de agente) se aplican al cargar el plugin con `parseConfig`. `defaultMode` por defecto es `native` (ver `docs/baseline.md`)._

### F-03 · Catálogo de tools por agente
- [ ] Resolver tools efectivas de cada agente tras políticas (`allow`, `alsoAllow`, profile, sandbox).
- [ ] Calcular tamaño estimado de cada schema (bytes y tokens aprox.).
- [ ] Generar descriptores compactos (nombre, descripción corta, firma de input).
- **Aceptación**: operación `catalog(agentId)` devuelve lista con `core | deferred | never` y tamaño.

### F-04 · Modo `plugin`: superficie mínima por turno
- [ ] Hook `before_prompt_build` devuelve `toolsAllow = core ∪ predichas ∪ activadas`, ordenado de forma determinista.
- [ ] Respetar que `toolsAllow` solo puede estrechar; nunca intentar añadir tools fuera de política.
- [ ] Saltar el hook (sin restringir) si el harness es Codex y avisar una vez en logs.
- **Aceptación**: con un prompt simple, el payload al proveedor contiene solo core + `lazy_load_tools`.

### F-05 · Tool `lazy_load_tools`
- [ ] Input: `{ query?: string; names?: string[] }`. Busca en el catálogo (BM25 léxico o exact match) y activa las tools en el estado de la sesión.
- [ ] Output: tools activadas con firma compacta y aviso de cuándo estarán disponibles (según F-00).
- [ ] Registrada como `direct-only` y siempre en `toolsAllow`.
- **Aceptación**: el agente pide "crear issue en GitHub", llama `lazy_load_tools`, y en el siguiente paso usa la tool real.

### F-06 · Estado de sesión y expiración
- [ ] Guardar tools activadas por `sessionKey` con contador de turnos (`stickyTurns`).
- [ ] Limpiar al cerrar sesión / `reset`.
- **Aceptación**: tras N turnos sin uso, la tool desaparece del set visible.

### F-07 · Predictor de intención (precarga)
- [ ] En `before_prompt_build`, usar `currentUserMessage` (no el historial) para predecir tools (keywords + BM25 sobre descriptores).
- [ ] Limitar a `maxPredicted`; respetar `never`.
- **Aceptación**: en un set de prompts de prueba, ≥80 % de las tools usadas estaban predichas o en core.

### F-08 · Modo `native`
- [ ] Escribir/leer config de `tools.toolSearch` (modo, límites) por agente o global según F-00.
- [ ] Mapear `core` a tools directas (o documentar el límite si el host no lo permite).
- **Aceptación**: `mode: native` produce el mismo flujo `tool_search → tool_call` que la doc oficial.

### F-09 · Métricas y telemetría
- [ ] Registrar por turno: agente, modo, nº tools visibles, bytes de schemas, TTFT (timestamps de prompt build vs primer output), loads, misses (`before_tool_call` sobre tool no visible o error "unknown tool").
- [ ] Persistir en storage del plugin con retención.
- [ ] Emitir eventos del feature contract para refrescar la UI.
- **Aceptación**: operación `stats(agentId, since)` devuelve medias p50/p95 de TTFT antes/después.

### F-10 · Feature contract (operaciones compartidas)
- [ ] Queries: `status`, `catalog`, `stats`, `sessionState`.
- [ ] Actions: `setMode`, `setAgentEnabled`, `setToolClass` (core/deferred/never), `resetSession`, `runBenchmark`.
- [ ] Eventos: `configChanged`, `statsUpdated`, `toolsLoaded`.
- **Aceptación**: UI, CLI y slash command usan solo estas operaciones.

### F-11 · Benchmark
- [ ] Ejecutar un prompt contra un agente en modo `off` y en modo lazy, N veces, y comparar TTFT y tokens.
- **Aceptación**: reporte reproducible; meta ≤10 s en tareas simples.

### F-12 · Tests
- [ ] Unit: predictor, cálculo de `toolsAllow`, expiración sticky, validación de config.
- [ ] Integración: escenario con proveedor mock (patrón `qa suite --provider-mode mock-openai`) comparando payloads.

---

## CLI

Raíz: `openclaw lazy-loading` (alias `openclaw lazy`), registrada con `api.registerCli` y `descriptors` para carga perezosa.

### C-01 · Registro del comando raíz
- [ ] `registerCli` con `descriptors` cubriendo `lazy-loading` y subcomandos; `--help` funcional sin cargar el runtime completo.

### C-02 · `status`
- [ ] `openclaw lazy-loading status [--agent <id>] [--json]`: modo, enabled, nº core/deferred, últimas métricas.

### C-03 · `enable` / `disable`
- [ ] `openclaw lazy-loading enable|disable (--agent <id> | --all)`.

### C-04 · `mode`
- [ ] `openclaw lazy-loading mode set <native|plugin|off> [--agent <id>]`.

### C-05 · `core` y `never`
- [ ] `openclaw lazy-loading core list|add|remove --agent <id> [tool...]`.
- [ ] `openclaw lazy-loading never list|add|remove --agent <id> [tool...]`.

### C-06 · `catalog`
- [ ] `openclaw lazy-loading catalog --agent <id> [--json] [--sort size]`: tools con clase y tamaño de schema.

### C-07 · `stats`
- [ ] `openclaw lazy-loading stats [--agent <id>] [--since 24h] [--json]`: TTFT p50/p95, tokens ahorrados, loads, misses.

### C-08 · `bench`
- [ ] `openclaw lazy-loading bench --agent <id> --prompt "..." [--runs 3]`: compara `off` vs modo lazy.

### C-09 · `reset`
- [ ] `openclaw lazy-loading reset --session <key> | --agent <id>`: limpia tools activadas.

### C-10 · Slash command en chat
- [ ] `/lazy` (status de la sesión), `/lazy load <tool|query>`, `/lazy reset`. Registrado con `api.registerCommand`, `requireAuth: true`.

### C-11 · Docs del CLI
- [ ] Sección en README con ejemplos y salida `--json` estable.

---

## UI

Tab nuevo **"Lazy Loading"** en la barra lateral del Control UI (`registerNavigation` + `registerPage`). Requiere Labs → Custom plugin UI activado. CSS y custom elements con prefijo `lazy-loading-`.

### U-01 · Entrada del navegador
- [ ] `defineControlUiPlugin({ id: "lazy-loading", activate(host) })`.
- [ ] Mensaje claro si el lab no está activo o el origen no es HTTPS/loopback.

### U-02 · Página: Overview
- [ ] Tarjetas: TTFT p50 antes/después, tokens de prompt ahorrados, loads y misses (24 h).
- [ ] Gráfico de TTFT por día y por agente.
- [ ] Datos vía `feature.watch(stats)` (sin polling).

### U-03 · Página: Agentes
- [ ] Tabla: agente, modo (select), enabled (toggle), nº core / deferred, TTFT p50.
- [ ] Cambios vía actions `setMode` / `setAgentEnabled`.

### U-04 · Detalle de agente: catálogo
- [ ] Lista de tools con clase `core | deferred | never` editable, tamaño de schema y uso reciente.
- [ ] Sugerencias: "tool usada en >X % de turnos, mover a core" y "tool core nunca usada, mover a deferred".

### U-05 · Actividad por sesión
- [ ] Tools activadas, predichas y misses por sesión; botón "Reset".

### U-06 · Benchmark
- [ ] Formulario (agente, prompt, runs), progreso y resultado comparativo.

### U-07 · Panel de sesión (opcional)
- [ ] `registerPanel` o `registerAccessory` con las tools cargadas en la sesión actual.

### U-08 · Estados y accesibilidad
- [ ] Loading, vacío, error con Retry; modo claro/oscuro; usable en ancho móvil.

---

## Orden sugerido

1. F-00 → F-01 → F-02 → F-03
2. F-04 → F-05 → F-06 (MVP en modo `plugin`) + C-01..C-05
3. F-09 → F-10 → C-06..C-09 → U-01..U-04
4. F-07 → F-08 → F-11 → U-05..U-07 → C-10
5. F-12, C-11, U-08

## Riesgos y preguntas abiertas

- **Harness Codex**: si los agentes `openai/gpt-5.6-*` corren sobre Codex, `toolsAllow` y `toolSearch` no aplican. Resolver en F-00.
- **Prompt cache**: cambiar el set de tools entre turnos invalida el cache. Mitigar con orden determinista y activaciones sticky.
- **Búsqueda solo en inglés**: el BM25 nativo espera queries en inglés; el predictor debe normalizar o el agente debe buscar en inglés.
- **APIs experimentales**: fijar versión del host y probar en cada actualización de OpenClaw.
