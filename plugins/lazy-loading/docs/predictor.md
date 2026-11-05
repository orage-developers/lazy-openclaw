# Predictor de tools

`predictTools` (`src/predictor/index.ts`) es un ranking puro y determinista. Recibe únicamente el mensaje de usuario actual; combina coincidencias léxicas y BM25 sobre nombre, descripción y firma compacta. Normaliza mayúsculas/acentos y aplica un pequeño mapa de equivalencias español/inglés. No consulta historial, red ni modelos.

La puntuación se limita a `[0, 1]`; `minScore` es inclusivo. Resultados empatan por nombre, y se limitan a `maxPredicted`. Se excluyen entradas `core`, `never`, `directOnly`, más nombres expresos en `core`/`never`. Solo se recomienda la clase `deferred` (las clases `core` y `never` del catálogo no se predicen).

## Evaluación de fixtures

El test define 10 pares prompt/tool, con intenciones españolas e inglesas, y exige al menos 8 aciertos dentro del top cinco (`minScore: 0.05`). Este es un umbral de regresión sobre un set pequeño y diseñado manualmente, no una medición de precisión/recall en uso real ni una garantía de cobertura real-world. Los prompts suelen contener pistas directas; variaciones, sinónimos y descripciones pobres pueden reducir la calidad.

## Límites

No hay stemming general, traducción ni comprensión semántica: el mapa bilingüe es intencionalmente acotado. BM25 mejora el orden relativo, pero el umbral absoluto debe calibrarse con inventarios y prompts representativos antes de activarlo en runtime. Un mensaje vacío o un límite no positivo produce `[]`.
