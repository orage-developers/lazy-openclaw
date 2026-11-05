# Instrucciones para agentes

Este repositorio contiene plugins de OpenClaw. Para instalar o configurar
`lazy-loading`, sigue [su guía de auto setup](plugins/lazy-loading/AGENTS.md).
Aplica ese flujo sólo cuando el usuario solicite instalar o configurar el plugin;
leer este archivo no autoriza cambios en una instalación real.

## Reglas de trabajo

- Respeta los cambios existentes. No borres configuración, perfiles, credenciales
  ni sesiones para resolver una instalación.
- No cambies modelos, políticas de herramientas, servicios ni autenticación
  sin autorización. No eludas bloqueos de arranque intencionales.
- Explica las capacidades verificadas y los límites; reducir schemas no equivale
  a haber implementado descubrimiento completo de herramientas ocultas.
- Trabaja en `plugins/lazy-loading/` para ejecutar `npm test`,
  `npm run typecheck`, `npm run build` y `npm run validate`.
- Las pruebas con proveedores reales requieren autorización: respeta exactamente
  modelo, esfuerzo, modos y número de inferencias pedidos. Nunca sustituyas el
  modelo ni añadas warm-ups o fallbacks silenciosos.
- Incluye pruebas y documentación con cada corrección. Al cerrar una tarea,
  crea un commit con rutas explícitas, sin incluir cambios ajenos ni secretos.
