# Instrucciones para agentes

Este repositorio contiene plugins de OpenClaw. Para instalar o configurar
`lazy-loading`, sigue [su guía de auto setup](plugins/lazy-loading/AGENTS.md).
Aplica ese flujo sólo cuando el usuario solicite instalar o configurar el plugin;
leer este archivo no autoriza cambios en una instalación real.

## Restricción vigente del operador (2026-11-05)

OpenClaw, Hermes y los contenedores Docker deben permanecer detenidos hasta que
el usuario autorice expresamente reabrirlos. No los arranques para instalar,
verificar salud, hacer benchmarks o completar el auto setup. No levantes un
Gateway alternativo ni uses `docker start`/`docker compose up` para eludirlo.
Conserva el bloqueo systemd de OpenClaw y las políticas Docker `restart=no`;
no los retires ni restaures reinicios automáticos sin esa autorización.
`docker.service` y `docker.socket` están enmascarados a nivel del sistema;
no los desenmascares ni uses otro motor/socket para saltarte la restricción.
El respaldo de las políticas previas está en
`~/.local/state/scout/operator-stop/20261105-154724/`.

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
