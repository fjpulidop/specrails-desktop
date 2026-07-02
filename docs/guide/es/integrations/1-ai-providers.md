# Proveedores de IA (Claude, Codex, Gemini)

Specrails no está atado a una única IA. Cada parte de la app que habla con una IA —Explore Spec, la spec rápida (Quick), los rails, el chat, AI Edit, el botón «Open AI CLI» del terminal— puede funcionar con cualquiera de los tres proveedores de primera clase. Tú eliges cuáles usa un proyecto, e incluso puedes cambiar de proveedor según la tarea.

## Los tres proveedores

| Proveedor | CLI | Creado por | Notas |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | El más completo. El único proveedor para Agents (perfiles) y los rails Freestyle, y para Contract Refine. |
| **Codex** | `codex` | OpenAI | Necesita codex `0.128.0+`. Lee sus servidores MCP desde tu `~/.codex/config.toml` global. |
| **Gemini** | `gemini` | Google | Necesita gemini `0.11.0+`. Usa telemetría nativa y un archivo de instrucciones `GEMINI.md`. |

Los tres están **activados por defecto**. Un proveedor aparece en **Añadir proyecto** siempre que su CLI esté instalado y en tu `PATH`. Así que el primer paso es siempre el mismo: instala la CLI que quieras y haz login con ella, exactamente como indica la documentación de esa herramienta. En cuanto `claude --version` (o `codex`, o `gemini`) funcione en tu terminal, Specrails podrá usarlo.

## Instalar un proveedor para un proyecto

Cuando añades un proyecto, el asistente de configuración te pregunta qué proveedor(es) instalar. Elige uno, completa el paso de instalación y listo. A partir de ahí el proyecto simplemente *tiene* ese proveedor: ya no tendrás que pensar en ello. Las specs, los rails, el chat y las analíticas funcionan igual independientemente del que hayas elegido.

Si una CLI que quieres no aparece en Añadir proyecto, casi siempre es porque la CLI no está instalada o no está en tu `PATH`. Instálala y vuelve a abrir Añadir proyecto.

## Instalar varios proveedores para un mismo proyecto

Puedes instalar **más de un** proveedor en el mismo proyecto; por ejemplo, Claude *y* Gemini. En **Añadir proyecto**, la lista de proveedores se convierte en un conjunto de casillas; marca todas las que quieras. El primero que selecciones se convierte en el proveedor **principal** (por defecto) del proyecto; el resto quedan disponibles como alternativas.

Algunas cosas que conviene saber sobre los proyectos multiproveedor:

- **Con un solo proveedor todo se comporta exactamente igual que antes.** Si un proyecto tiene un único proveedor, no verás ningún selector de proveedor en ninguna parte: la app se mantiene limpia y sencilla.
- **La barra lateral derecha solo muestra las secciones que admiten todos los proveedores instalados.** Como Agents (perfiles) es un concepto exclusivo de Claude, la sección **Agents** desaparece en cuanto un proyecto incluye algún proveedor que no sea Claude. Todo lo demás (Specs, Code, Analytics, Integraciones, Terminal, Chat) se mantiene.
- **La elección de proveedor queda bloqueada tras la creación.** En esta versión eliges tus proveedores al añadir el proyecto y no se pueden cambiar después desde Ajustes. Si necesitas una combinación distinta, crea un proyecto nuevo.

## Elegir un proveedor por cada invocación

La verdadera ventaja de un proyecto multiproveedor es poder elegir la IA adecuada para cada tarea, sin tocar ningún ajuste global. Allí donde se ejecuta una IA aparece un pequeño selector de proveedor (solo cuando el proyecto tiene más de uno):

- **Añadir spec** — un selector de motor te deja explorar o generar una spec en modo rápido (Quick) con el proveedor que prefieras.
- **Cabecera del rail** — elige el motor para ese rail concreto antes de lanzarlo.
- **Terminal** — el botón «Open AI CLI» (el icono de chispas) abre un menú de proveedores para que puedas entrar en cualquier CLI instalada en el directorio de ese proyecto.

Tu elección se recuerda por proyecto y toma el proveedor principal por defecto, así que no tienes que volver a elegirla cada vez.

## Lo que solo Claude puede hacer

Un puñado de funciones son específicas de Claude por naturaleza, así que se ocultan o se omiten cuando hay otro proveedor en juego:

- **Agents (perfiles)** — el catálogo de agentes por proyecto y el enrutado de modelos. Se oculta en cualquier proyecto que incluya un proveedor que no sea Claude.
- **Rails Freestyle** — siempre se ejecutan con Claude.
- **Contract Refine** — la pasada adicional de «Contract Layer» sobre una spec confirmada solo se ejecuta cuando el proveedor de la conversación es Claude.
- **Modos avanzados de Añadir spec** (SMASH / Contract Layer) — se ocultan para los motores que no sean Claude.

Todo lo demás —Explore, la spec rápida (Quick), el pipeline completo de rails, AI Edit, el chat y las analíticas de coste— funciona con los tres.

## Seguimiento de costes entre proveedores

La página de **Analytics** registra cada invocación facturable independientemente del proveedor. En los proyectos multiproveedor añade chips de filtro por motor para que puedas comparar el gasto por proveedor. Claude informa de su coste exacto; para Codex y Gemini, Specrails estima el coste a partir de una tarifa interna, así que las cifras son aproximaciones cercanas y no importes facturados.

## Resolución de problemas

- **No aparece un proveedor que instalé.** Confirma que la CLI está en tu `PATH` (prueba `claude --version` / `codex --version` / `gemini --version` en un terminal nuevo). La app detecta las CLI de los proveedores a través del `PATH` de tu sistema.
- **Los servidores MCP de Codex no se cargan en el chat.** Codex lee los servidores MCP desde tu `~/.codex/config.toml` global; regístralos ahí con `codex mcp add`.
- **Desactivación de emergencia.** Un proveedor se puede desactivar en toda la app mediante una variable de entorno (`SPECRAILS_CODEX_BETA=0` o `SPECRAILS_GEMINI_BETA=0`). Esto solo oculta el proveedor de la *selección*; rara vez es necesario.

## Véase también

Las guías dedicadas a cada proveedor profundizan en cada CLI: la guía de Codex y la guía de Gemini cubren la configuración, lo que funciona y las peculiaridades de cada proveedor.
