# Auto setup de Lazy Loading

Esta guía instruye al agente que instala el plugin; **no es un script, un hook
de instalación ni un setup que OpenClaw ejecute automáticamente**. Sigue el flujo
cuando el usuario autorice instalar/configurar Lazy Loading, sin pedirle que
realice manualmente pasos que el agente pueda ejecutar de forma segura.

## 1. Detectar y respaldar

- Ejecuta `openclaw --version`, `openclaw config file`,
  `openclaw config validate` y `openclaw gateway status`.
- Respeta el perfil y las variables `OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH`.
  No asumas `~/.openclaw` si el host indica otra ubicación.
- La versión verificada es **2026.9.5**. En otra versión, verifica compatibilidad
  de APIs antes de instalar; no actualices ni rebajes OpenClaw automáticamente.
- Guarda una copia privada de la configuración y registra los valores previos
  de las rutas que cambiarás: directorio `700`, archivo `600`. No muestres secretos.
- Registra si el plugin ya existía. Conserva sus ajustes de agentes, core, never,
  predictor y retención; no reemplaces la entrada completa para aplicar defaults.

## 2. Instalar el artefacto

Desde un checkout, trabaja en el directorio del plugin:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run validate
npm pack --pack-destination "$ARTIFACT_DIR"
```

Define `ARTIFACT_DIR` como un directorio privado de trabajo y comprueba que el
archivo generado contiene `dist/`, el manifiesto, `AGENTS.md` y `docs/`.
Si recibiste un paquete ya construido, verifica su procedencia y contenido;
no necesitas compilarlo. Instala **la ruta exacta del archivo `.tgz`** mediante
`openclaw plugins install`. No copies `node_modules` de desarrollo al host.
Usa `--force` sólo para confirmar una fuente local conocida o actualizar este
plugin; acepta capacidades sólo después de revisarlas y contar con autorización.

Con `PLUGIN_TGZ` resuelto a ese archivo y la fuente/capacidades autorizadas:

```sh
openclaw plugins install "$PLUGIN_TGZ" --force --accept-capabilities
```

Si la instalación falla, revisa su resultado antes de repetirla. No borres
staging, backups ni extensiones ajenas y no dejes el paquete desaparecido.

## 3. Configurar sin ampliar permisos

Para una instalación nueva **sin configuración previa**, aplica rutas separadas:

```sh
openclaw config set plugins.entries.lazy-loading.enabled true --strict-json
openclaw config set plugins.entries.lazy-loading.config.enabled true --strict-json
openclaw config set plugins.entries.lazy-loading.config.defaultMode '"off"' --strict-json
```

- Solicita o confirma permiso para observar conversaciones antes de establecer
  `plugins.entries.lazy-loading.hooks.allowConversationAccess` en `true`.
  El hook `llm_input` lo requiere. No cambies permisos de tools, sandbox ni auth.
- Consulta `openclaw lazy-loading status --json` y el modelo/runtime efectivo
  del agente elegido; no deduzcas el runtime sólo por el prefijo `openai/`.
- **Embedded compatible:** activa `plugin` sólo si el usuario acepta reducción
  inicial a core + loader y el límite de descubrimiento indicado abajo.
  Usa `openclaw lazy-loading mode set plugin --agent <id>` y
  `openclaw lazy-loading enable --agent <id>` con el identificador real.
- **Codex, CLI o runtime desconocido:** no intentes restringir. Deja el agente
  en `off` y explica la incompatibilidad; no cambies su modelo para ocultarla.
- Mantén `off` para agentes no seleccionados en una instalación nueva. En una
  existente conserva sus valores. No uses `native` como fallback automático:
  su gestión de `tools.toolSearch` todavía no está implementada (F-08).

**Límite obligatorio:** la reducción inicial funciona, pero no es carga diferida
completa. El host expone `llm_input` después del filtro; sin un catálogo completo
observado previamente o proporcionado de forma confiable, el loader no puede
descubrir tools que ya ocultó. Las activaciones conocidas aplican desde el
siguiente turno, no dentro del actual. No anuncies resolución automática de este
límite ni inventes inventarios. Detalles: [runtime.md](docs/runtime.md).

## 4. Verificar y cerrar

Ejecuta `openclaw config validate`, `openclaw plugins inspect lazy-loading`,
`openclaw lazy-loading status --json` y, si el Gateway estaba activo,
`openclaw gateway health`. Verifica `effectiveMode`, no sólo `mode`.
Un CLI nuevo puede mostrar conteos `null` porque no comparte inventario en memoria.

Respeta la recarga que indique el host; no reinicies si ya aplicó hot reload.
Si estaba apagado o tiene un bloqueo intencional como `RefuseManualStart=yes`,
pide autorización antes de arrancarlo o modificar ese bloqueo.

No ejecutes inferencias pagadas como parte del setup sin autorización. Si se pide
una comparación, usa mismo prompt/modelo/esfuerzo y exactamente el número de runs
solicitado; mide TTFT hasta el primer delta de texto, no hasta el primer evento
ni hasta el fin del turno. Diferencia wire payload de informes del host.

Si el plugin causa un fallo nuevo, desactívalo con
`openclaw config set plugins.entries.lazy-loading.enabled false --strict-json`
y comprueba salud. Revierte sólo tus rutas y cambios, sin restaurar ciegamente
todo el backup sobre cambios posteriores. No borres sesiones o credenciales.
Entrega versión, perfil, agentes/modos efectivos, verificaciones, límites y
ubicación del respaldo. Documentación operativa: [CLI](docs/cli.md).
