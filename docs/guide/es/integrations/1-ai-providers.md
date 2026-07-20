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

## Instalar un proveedor para un proyecto

Cuando añades un proyecto, el asistente de configuración te pregunta qué proveedor(es) instalar. Elige uno, completa el paso de instalación y listo. A partir de ahí el proyecto simplemente *tiene* ese proveedor: ya no tendrás que pensar en ello. Las specs, los rails, el chat y las analíticas funcionan igual independientemente del que hayas elegido.

Si una CLI que quieres no aparece en Añadir proyecto, casi siempre es porque la CLI no está instalada o no está en tu `PATH`. Instálala y vuelve a abrir Añadir proyecto.

## Instalar varios proveedores para un mismo proyecto

Puedes instalar **más de un** proveedor en el mismo proyecto; por ejemplo, Claude *y* Gemini. En **Añadir proyecto**, la lista de proveedores se convierte en un conjunto de casillas; marca todas las que quieras. El primero que selecciones se convierte en el proveedor **principal** (por defecto) del proyecto; el resto quedan disponibles como alternativas.

Algunas cosas que conviene saber sobre los proyectos multiproveedor:

- **Con un solo proveedor todo se comporta exactamente igual que antes.** Si un proyecto tiene un único proveedor, no verás ningún selector de proveedor en ninguna parte: la app se mantiene limpia y sencilla.
- **Las capacidades gobiernan la interfaz.** Claude y Kimi admiten perfiles
  separados por proveedor; Codex y Gemini ejecutan los rails en modo legacy.
- **La elección de proveedor queda bloqueada tras la creación.** En esta versión eliges tus proveedores al añadir el proyecto y no se pueden cambiar después desde Ajustes. Si necesitas una combinación distinta, crea un proyecto nuevo.

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
