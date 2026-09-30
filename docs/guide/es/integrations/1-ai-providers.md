# Proveedores de IA (Claude, Codex)

Specrails no está atado a una única IA. Claude y Codex son
proveedores de primera clase; cada superficie muestra solo los motores cuyas
capacidades cumplen su contrato.

## Los cuatro proveedores

| Proveedor | CLI | Creado por | Notas |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Coste nativo y transporte interactivo persistente. |
| **Codex** | `codex` | OpenAI | Necesita codex `0.128.0+`. Lee sus servidores MCP desde tu `~/.codex/config.toml` global. |

## Los proveedores se detectan automáticamente

Si un proveedor que quieres no aparece por ningún sitio, casi siempre es porque
el CLI no está instalado o no está en tu `PATH`. Instálalo, inicia sesión y
vuelve a la app — la detección se re-ejecuta al enfocar la ventana y el
proveedor aparece por sí solo en todas partes, con su superficie de workspace
ensamblada en segundo plano. Un proveedor instalado pero sin sesión iniciada
sigue apareciendo, con una insignia *Sin iniciar sesión* en los selectores de motor.

Algunas cosas útiles sobre máquinas multi-proveedor:

- **Un solo proveedor se comporta exactamente como antes.** Si solo se detecta uno, nunca verás un selector de proveedor — la app se mantiene limpia y simple.
- **Nada queda bloqueado.** Instalar o quitar un CLI de proveedor actualiza todos
  los proyectos automáticamente — no hay ajuste de proveedor por proyecto que gestionar.

## Elegir un proveedor por cada invocación

La verdadera ventaja de un proyecto multiproveedor es poder elegir la IA adecuada para cada tarea, sin tocar ningún ajuste global. Allí donde se ejecuta una IA aparece un pequeño selector de proveedor (solo cuando el proyecto tiene más de uno):

- **Cabecera del rail** — elige el motor para ese rail concreto antes de lanzarlo.
- **Terminal** — el botón «Open AI CLI» (el icono de chispas) abre un menú de proveedores para que puedas entrar en cualquier CLI instalada en el directorio de ese proyecto.

Tu elección se recuerda por proyecto y toma el proveedor principal por defecto, así que no tienes que volver a elegirla cada vez.

## Resolución de problemas

- **Los servidores MCP de Codex no se cargan en el chat.** Codex lee los servidores MCP desde tu `~/.codex/config.toml` global; regístralos ahí con `codex mcp add`.
