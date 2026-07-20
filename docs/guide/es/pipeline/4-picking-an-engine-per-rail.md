# Elegir un motor por rail

Specrails desktop trata **Claude Code**, **Codex CLI**, **Gemini CLI** y
**Kimi Code** como motores de primera clase. Un proyecto puede instalar
cualquier combinación compatible.

## Cuándo aparece el selector

El **selector de motor** vive en la cabecera del rail, justo al lado del control de modo. Solo se muestra cuando el proyecto tiene **más de un** proveedor instalado.

> **Los proyectos de un solo proveedor se comportan de forma byte-idéntica.** Si un proyecto tiene un único motor, no se muestra ningún selector y nada cambia respecto a la selección de proveedor — sencillamente se ejecuta en ese motor. El selector es exclusivo para proyectos multiproveedor.

Cuando sí aparece, tu elección es **por rail y por lanzamiento** — distintos rails pueden ejecutar distintos motores, y tu elección se recuerda por proyecto (con el motor principal del proyecto como valor por defecto).

## Cómo elegir un motor

1. Asegúrate de que el selector de motor del rail está visible (el proyecto tiene 2 o más proveedores).
2. Púlsalo y elige **Claude**, **Codex**, **Gemini** o **Kimi**.
3. Lanza el rail con **▶ Play**.

El motor seleccionado ejecuta cada fase del pipeline de ese rail. Si la CLI del motor elegido no está instalada, el lanzamiento falla rápido — no se arranca nada. Instala la CLI que falta y vuelve a intentarlo.

## En qué destaca cada motor

Los cuatro ejecutan **Implement** y **Batch**:

| Motor | Recurre a él cuando… | Notas |
|--------|--------------------|-------|
| **Claude** | Necesitas coste nativo, interacción persistente o políticas de tools estrictas. | Perfiles, Freestyle y transforms estructurados. |
| **Codex** | Prefieres la CLI de OpenAI Codex o quieres comparar implementaciones entre proveedores. | `codex` ≥ 0.128.0. Sin reporte de coste nativo — la app rellena el coste desde su tarifario. Los perfiles no aplican. |
| **Gemini** | Quieres la CLI de Gemini de Google, telemetría nativa o una ejecución más barata para specs rutinarias. | `gemini` ≥ 0.11.0 (define `GEMINI_API_KEY`). Telemetría OTLP nativa. Los perfiles no aplican. |
| **Kimi** | Quieres Kimi agentic para Implement, Batch, Freestyle o loops sin Decider. | `kimi` ≥ 0.27.0 externo; perfiles/roles y effort low/high/max solo para K3; tokens/coste no disponibles. |

### Diferencias de capacidad

Claude y Kimi admiten perfiles y Freestyle; Codex/Gemini usan legacy. Kimi no
admite Loop Decider ni los transforms pure-output enumerados en la
[guía Kimi](../../../kimi.md). Los perfiles Claude/Kimi están separados por
proveedor.

## Un flujo de trabajo práctico

Los proyectos multiproveedor brillan cuando quieres **comparar** o **afinar costes**:

- **Comparar implementaciones.** Pon la misma spec en dos rails, configura uno con Claude y otro con Codex, lánzalos los dos (entre proyectos, o uno tras otro en la cola del mismo proyecto) y luego usa el botón **Comparar** en la página Jobs para enfrentar los resultados.
- **Afinar costes por spec.** Ejecuta las specs de alto riesgo en Claude con un perfil `max`; ejecuta las specs rutinarias de limpieza en Gemini para ahorrar gasto. Filtra `/analytics` por motor para ver el desglose.
- **Pon un valor por defecto con cabeza.** Configura el motor que más usas como principal del proyecto para que los rails lo adopten por defecto, y cambia por rail solo cuando una spec concreta quiera uno distinto.

## Cosas a tener en cuenta

- **La selección de proveedor es inmutable tras crear el proyecto** (v1). Eliges los proveedores instalados al añadir el proyecto; no hay un interruptor en Ajustes para añadir o quitar uno después.
- **Las métricas disponibles se registran.** Kimi no emite tokens ni coste USD
  autoritativos; esos campos quedan vacíos.
- **El botón "Abrir CLI de IA" del terminal** también ofrece un selector de proveedor en proyectos multiproveedor, por si prefieres manejar una CLI a mano.

## A dónde ir después

- [Usar Codex](../integrations/using-codex) — instalar e iniciar sesión.
- [Usar Gemini](../integrations/using-gemini) — instalar, `GEMINI_API_KEY`, telemetría.
- [Usar Kimi](../../../kimi.md) — instalación y matriz completa.
- [Rails y jobs](rails-and-jobs) — la cola y el flujo de lanzamiento.
- [Seguimiento de costes](../analytics/tracking-cost) — desglose de coste por motor.
