<!-- guide-revision: mission-first-v1 -->

# Elige proveedor y capacidades

La configuración depende del proveedor elegido. Un nombre de modelo conocido no implica las mismas opciones de razonamiento, salida estructurada o aprobación en todos ellos.

## Comprueba la disponibilidad

Autentica la CLI y revisa su estado en Specrails. Elige entre los modelos y niveles que ofrecen sus controles. Tener instalada la CLI no evita fallos de sesión, cuota o servicio remoto.

Claude y Codex usan adaptadores distintos. Las combinaciones incompatibles deben fallar antes de empezar; un paso que exija una respuesta estructurada sin herramientas no funciona necesariamente con todos.

## Usa el nivel de control adecuado

El proveedor y modelo del rail controlan su ejecución. Los perfiles y el enrutado por rol dependen del proveedor y del flujo de Core que Desktop instaló en el proyecto: revisa la configuración efectiva.

Para comparar ejecuciones, conserva spec, revisión y criterios de verificación. Distingue costes reportados, estimados y no disponibles. Consulta [perfiles](/docs/agents-profiles-and-the-balanced-default) y [consumo](/docs/insights-analytics-and-cost-tracking).

Al lanzar desde una misión, los pasos del loop heredan su proveedor, modelo y esfuerzo salvo que se indiquen otros explícitamente en el editor del loop. Los ajustes generales gestionan las conexiones; ya no se ofrecen el bloque Valores por defecto del proveedor ni la opción Roles.
