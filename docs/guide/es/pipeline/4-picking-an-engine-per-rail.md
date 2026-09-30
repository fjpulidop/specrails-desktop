# Elegir un motor por rail

## Cuándo aparece el selector

El **selector de motor** vive en la cabecera del rail, justo al lado del control de modo. Solo se muestra cuando el proyecto tiene **más de un** proveedor instalado.

> **Los proyectos de un solo proveedor se comportan de forma byte-idéntica.** Si un proyecto tiene un único motor, no se muestra ningún selector y nada cambia respecto a la selección de proveedor — sencillamente se ejecuta en ese motor. El selector es exclusivo para proyectos multiproveedor.

Cuando sí aparece, tu elección es **por rail y por lanzamiento** — distintos rails pueden ejecutar distintos motores, y tu elección se recuerda por proyecto (con el motor principal del proyecto como valor por defecto).

## Cómo elegir un motor

El motor seleccionado ejecuta cada fase del pipeline de ese rail. Si la CLI del motor elegido no está instalada, el lanzamiento falla rápido — no se arranca nada. Instala la CLI que falta y vuelve a intentarlo.

## En qué destaca cada motor

Los cuatro ejecutan **Implement**:

| Motor | Recurre a él cuando… | Notas |
|--------|--------------------|-------|
| **Claude** | Necesitas coste nativo, interacción persistente o políticas de tools estrictas. | Perfiles, Freestyle y transforms estructurados. |
| **Codex** | Prefieres la CLI de OpenAI Codex o quieres comparar implementaciones entre proveedores. | `codex` ≥ 0.128.0. Sin reporte de coste nativo — la app rellena el coste desde su tarifario. Los perfiles no aplican. |

## Un flujo de trabajo práctico

Los proyectos multiproveedor brillan cuando quieres **comparar** o **afinar costes**:

- **Comparar implementaciones.** Pon la misma spec en dos rails, configura uno con Claude y otro con Codex, lánzalos los dos (entre proyectos, o uno tras otro en la cola del mismo proyecto) y luego usa el botón **Comparar** en la página Jobs para enfrentar los resultados.
- **Pon un valor por defecto con cabeza.** Configura el motor que más usas como principal del proyecto para que los rails lo adopten por defecto, y cambia por rail solo cuando una spec concreta quiera uno distinto.

## Cosas a tener en cuenta

- **La selección de proveedor es inmutable tras crear el proyecto** (v1). Eliges los proveedores instalados al añadir el proyecto; no hay un interruptor en Ajustes para añadir o quitar uno después.
- **El botón "Abrir CLI de IA" del terminal** también ofrece un selector de proveedor en proyectos multiproveedor, por si prefieres manejar una CLI a mano.

## A dónde ir después

- [Usar Codex](../integrations/using-codex) — instalar e iniciar sesión.
- [Rails y jobs](rails-and-jobs) — la cola y el flujo de lanzamiento.
- [Seguimiento de costes](../analytics/tracking-cost) — desglose de coste por motor.
