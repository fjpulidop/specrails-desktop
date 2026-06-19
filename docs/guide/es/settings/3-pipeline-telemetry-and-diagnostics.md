# Telemetría del pipeline y diagnósticos

Cuando un job del pipeline no sale como esperabas, la telemetría te ofrece un registro detallado, entre bambalinas, de lo que el CLI de IA hizo en realidad. Está **desactivada por defecto** y es totalmente opcional, por proyecto: actívala solo cuando la quieras.

## Qué es

La telemetría captura señales de diagnóstico estructuradas (trazas, métricas y logs) que el CLI de IA emite mientras ejecuta un job del pipeline. Piénsalo como la caja negra de tus ejecuciones del pipeline: tiempos, uso de tokens y actividad paso a paso, capturados en local para que puedas inspeccionar un job después de los hechos.

Está construida sobre **OpenTelemetry**, un formato abierto y estándar, así que los datos no quedan encerrados en una caja propietaria.

## Cómo activarla

La telemetría se configura **por proyecto**:

1. Abre la página de **Ajustes** del proyecto (la ruta de ajustes específica del proyecto).
2. Localiza el interruptor de **Telemetría del pipeline**.
3. Actívalo.

A partir de ese momento, los jobs del pipeline de ese proyecto registran telemetría. Los demás proyectos no se ven afectados: cada proyecto decide por sí mismo.

### Qué se cubre

La telemetría se aplica a los **jobs del pipeline** (las ejecuciones de rail en cola Architect → Developer → Reviewer → Ship). Las sesiones interactivas, como el chat y el asistente de configuración, se dejan fuera a propósito: la telemetría está pensada para las ejecuciones del pipeline, repetibles e inspeccionables, no para conversaciones puntuales.

## Dónde viven los datos

Todo se queda en tu máquina, dentro de tu directorio personal (`~/.specrails/`), nunca en tu repo. Las grabaciones en bruto se guardan comprimidas junto a su job, y las más antiguas se condensan automáticamente en resúmenes compactos al cabo de una semana para mantenerlo todo ordenado. No tienes que gestionar nada de esto a mano.

## Exportar un paquete de diagnóstico

Lo más útil que la telemetría desbloquea es la **exportación de diagnóstico**: un único ZIP que empaqueta todo lo relativo a un job para resolver problemas o compartirlo.

Cuando un job tiene telemetría registrada, aparece un **botón de exportación** en su tarjeta de job. Pulsa para descargar un ZIP que contiene:

- **`job-metadata.json`** — la identidad y los parámetros del job
- **`telemetry.ndjson`** — las señales registradas en bruto
- **`logs.txt`** — la salida de log capturada
- **`summary.md`** — un resumen legible de la ejecución

Si el proyecto usa plugins, el paquete también incluye una instantánea de qué plugins estuvieron activos en ese job.

Este es el paquete que conviene tener a mano cuando quieres entender una ejecución espinosa, dejar constancia o pasarle los detalles a alguien que te esté ayudando a depurar.

## Cómo desactivarla

Vuelve a apagar el interruptor cuando quieras. Los nuevos jobs dejan de registrar de inmediato. Lo que ya se capturó se mantiene en disco hasta que se compacta o eliminas el proyecto: nada se envía a ninguna parte ni se pierde a tus espaldas.
