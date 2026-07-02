# Elegir un motor por rail

Specrails desktop trata **Claude Code**, **Codex CLI** y **Gemini CLI** como motores de primera clase. Un proyecto puede tener uno, dos o los tres instalados — y cuando hay más de uno, eliges qué motor ejecuta cada rail. Esta página cubre el selector de motor por rail y cuándo recurrir a cada uno.

## Cuándo aparece el selector

El **selector de motor** vive en la cabecera del rail, justo al lado del control de modo. Solo se muestra cuando el proyecto tiene **más de un** proveedor instalado.

> **Los proyectos de un solo proveedor se comportan de forma byte-idéntica.** Si un proyecto tiene un único motor, no se muestra ningún selector y nada cambia respecto a la selección de proveedor — sencillamente se ejecuta en ese motor. El selector es exclusivo para proyectos multiproveedor.

Cuando sí aparece, tu elección es **por rail y por lanzamiento** — distintos rails pueden ejecutar distintos motores, y tu elección se recuerda por proyecto (con el motor principal del proyecto como valor por defecto).

## Cómo elegir un motor

1. Asegúrate de que el selector de motor del rail está visible (el proyecto tiene 2 o más proveedores).
2. Púlsalo y elige **Claude**, **Codex** o **Gemini**.
3. Lanza el rail con **▶ Play**.

El motor seleccionado ejecuta cada fase del pipeline de ese rail. Si la CLI del motor elegido no está instalada, el lanzamiento falla rápido — no se arranca nada. Instala la CLI que falta y vuelve a intentarlo.

## En qué destaca cada motor

Los tres ejecutan los pipelines estándar **Implement** y **Batch**. Aquí tienes una guía práctica para elegir:

| Motor | Recurre a él cuando… | Notas |
|--------|--------------------|-------|
| **Claude** | Quieres el conjunto completo de funciones: perfiles de agentes, Freestyle, reporte de coste nativo, el soporte de herramientas más rico. El predeterminado para la mayoría del trabajo. | El único motor que admite **perfiles de agentes**, **Freestyle** y algunas funciones de spec exclusivas de Claude (Contract Layer, SMASH). |
| **Codex** | Prefieres la CLI de OpenAI Codex o quieres comparar implementaciones entre proveedores. | `codex` ≥ 0.128.0. Sin reporte de coste nativo — la app rellena el coste desde su tarifario. Los perfiles no aplican. |
| **Gemini** | Quieres la CLI de Gemini de Google, telemetría nativa o una ejecución más barata para specs rutinarias. | `gemini` ≥ 0.11.0 (define `GEMINI_API_KEY`). Telemetría OTLP nativa. Los perfiles no aplican. |

### Las funciones exclusivas de Claude

Algunas cosas solo funcionan en rails de Claude — elige Claude si las necesitas:

- **Perfiles de agentes** — enrutamiento de modelo por agente. En rails de Codex o Gemini la ejecución siempre usa el modo legacy y cualquier perfil seleccionado se **ignora**. El selector de perfil se oculta para los motores que no son Claude.
- **Freestyle** — el modo autónomo que se salta el pipeline. El segmento `Freestyle` y su selector de modelo Haiku/Sonnet/Opus solo aparecen cuando el motor del rail es Claude.
- **Contract Layer y SMASH** — funciones de refinamiento de spec exclusivas de Claude (son opciones de Add-Spec, no de rail, pero aplica la misma restricción).

Si un proyecto mezcla motores, la barra lateral derecha solo muestra las secciones que **todos** los proveedores instalados admiten — así, la sección **Agents** desaparece por completo en un proyecto que incluya cualquier proveedor que no sea Claude, porque los perfiles son específicos de Claude.

## Un flujo de trabajo práctico

Los proyectos multiproveedor brillan cuando quieres **comparar** o **afinar costes**:

- **Comparar implementaciones.** Pon la misma spec en dos rails, configura uno con Claude y otro con Codex, lánzalos los dos (entre proyectos, o uno tras otro en la cola del mismo proyecto) y luego usa el botón **Comparar** en la página Jobs para enfrentar los resultados.
- **Afinar costes por spec.** Ejecuta las specs de alto riesgo en Claude con un perfil `max`; ejecuta las specs rutinarias de limpieza en Gemini para ahorrar gasto. Filtra `/analytics` por motor para ver el desglose.
- **Pon un valor por defecto con cabeza.** Configura el motor que más usas como principal del proyecto para que los rails lo adopten por defecto, y cambia por rail solo cuando una spec concreta quiera uno distinto.

## Cosas a tener en cuenta

- **La selección de proveedor es inmutable tras crear el proyecto** (v1). Eliges los proveedores instalados al añadir el proyecto; no hay un interruptor en Ajustes para añadir o quitar uno después.
- **El coste siempre se registra**, incluso para los motores sin reporte de coste nativo — la app recurre a un tarifario para que las ejecuciones de Codex y Gemini también aparezcan en [analíticas](../analytics/tracking-cost).
- **El botón "Abrir CLI de IA" del terminal** también ofrece un selector de proveedor en proyectos multiproveedor, por si prefieres manejar una CLI a mano.

## A dónde ir después

- [Usar Codex](../integrations/using-codex) — instalar e iniciar sesión.
- [Usar Gemini](../integrations/using-gemini) — instalar, `GEMINI_API_KEY`, telemetría.
- [Rails y jobs](rails-and-jobs) — la cola y el flujo de lanzamiento.
- [Seguimiento de costes](../analytics/tracking-cost) — desglose de coste por motor.
