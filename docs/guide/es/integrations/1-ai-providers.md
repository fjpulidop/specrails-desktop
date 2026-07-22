# Proveedores de IA (Claude, Codex, Gemini, Kimi)

Specrails no está atado a una única IA. Claude, Codex, Gemini y Kimi son
proveedores de primera clase; cada superficie muestra solo los motores cuyas
capacidades cumplen su contrato.

## Los cuatro proveedores

| Proveedor | CLI | Creado por | Notas |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Coste nativo y transporte interactivo persistente. |
| **Codex** | `codex` | OpenAI | Necesita codex `0.128.0+`. Lee sus servidores MCP desde tu `~/.codex/config.toml` global. |
| **Gemini** | `gemini` | Google | Necesita gemini `0.11.0+`. Usa telemetría nativa y un archivo de instrucciones `GEMINI.md`. |
| **Kimi Code** | `kimi` | Moonshot AI | Necesita Kimi `0.27.0+`. Desktop usa la CLI externa con `-p`; no instala ni inicia un servidor. |

Los cuatro están **activados por defecto**. Un proveedor aparece en **Añadir
proyecto** cuando su CLI está instalada y en tu `PATH`. Para Kimi, comprueba
`kimi --version` y ejecuta `kimi login`.

## Los proveedores se detectan automáticamente

Nunca eliges proveedores por proyecto. Specrails detecta cada CLI de proveedor
instalado en tu máquina y pone **todos** a disposición de **todos** los
proyectos, siempre. Cada superficie comprueba después las capacidades que el
proveedor anuncia. Consulta [Usar Kimi](../../../kimi.md) para la matriz exacta de Kimi.

Si un proveedor que quieres no aparece por ningún sitio, casi siempre es porque
el CLI no está instalado o no está en tu `PATH`. Instálalo, inicia sesión y
vuelve a la app — la detección se re-ejecuta al enfocar la ventana y el
proveedor aparece por sí solo en todas partes, con su superficie de workspace
ensamblada en segundo plano. Un proveedor instalado pero sin sesión iniciada
sigue apareciendo, con una insignia *Sin iniciar sesión* en los selectores de motor.

Algunas cosas útiles sobre máquinas multi-proveedor:

- **Un solo proveedor se comporta exactamente como antes.** Si solo se detecta uno, nunca verás un selector de proveedor — la app se mantiene limpia y simple.
- **Las capacidades gobiernan la barra lateral.** Una sección es visible cuando
  al menos un proveedor detectado la soporta; dentro, las acciones por motor solo
  ofrecen los proveedores capaces. Kimi anuncia perfiles, roles personalizados y
  Freestyle; no anuncia acciones estructuradas que requieran un límite sin
  herramientas exigible.
- **Nada queda bloqueado.** Instalar o quitar un CLI de proveedor actualiza todos
  los proyectos automáticamente — no hay ajuste de proveedor por proyecto que gestionar.

## Elegir un proveedor por cada invocación

La verdadera ventaja de un proyecto multiproveedor es poder elegir la IA adecuada para cada tarea, sin tocar ningún ajuste global. Allí donde se ejecuta una IA aparece un pequeño selector de proveedor (solo cuando el proyecto tiene más de uno):

- **Añadir spec** — Explore permite Kimi; Quick Spec solo muestra proveedores
  que pueden imponer su límite pure-output, por lo que Kimi no aparece ahí.
- **Cabecera del rail** — elige el motor para ese rail concreto antes de lanzarlo.
- **Terminal** — el botón «Open AI CLI» (el icono de chispas) abre un menú de proveedores para que puedas entrar en cualquier CLI instalada en el directorio de ese proyecto.

Tu elección se recuerda por proyecto y toma el proveedor principal por defecto, así que no tienes que volver a elegirla cada vez.

## Diferencias de capacidades

Kimi admite Project/Agent Chat, Explore y propuestas, Quick Launcher
(`/opsx:ff`), rails, Freestyle, loops sin Decider, perfiles/roles manuales,
MCP, Serena, terminal y adjuntos.

Kimi `-p` aprueba herramientas automáticamente y no puede imponer un límite
sin herramientas/read-only. Por eso fallan antes de iniciar el proceso:
Quick Spec, AI Edit, Contract Refine, SMASH/Re-SMASH, generación de
blueprints/milestones de Project Builder, Loop Decider, resúmenes e historia
de construcción, y automatización de Agent Studio. El auto-title usa un
fallback determinista. Consulta la [guía completa de Kimi](../../../kimi.md).

## Seguimiento de costes entre proveedores

La página de **Analytics** registra las invocaciones que llegan a ejecutarse.
Claude informa de su coste; Codex y Gemini usan una estimación. Kimi no emite
tokens ni coste USD autoritativos, por lo que esos campos quedan vacíos.

## Resolución de problemas

- **No aparece un proveedor que instalé.** Confirma que la CLI está en tu `PATH` (prueba `claude --version` / `codex --version` / `gemini --version` / `kimi --version` en un terminal nuevo).
- **Los servidores MCP de Codex no se cargan en el chat.** Codex lee los servidores MCP desde tu `~/.codex/config.toml` global; regístralos ahí con `codex mcp add`.
- **Desactivación de emergencia.** Un proveedor se puede desactivar en toda la app mediante una variable de entorno (`SPECRAILS_CODEX_BETA=0` o `SPECRAILS_GEMINI_BETA=0`). Esto solo oculta el proveedor de la *selección*; rara vez es necesario.

## Véase también

Las guías dedicadas a cada proveedor profundizan en cada CLI: consulta
[Kimi](../../../kimi.md), Codex y Gemini.
