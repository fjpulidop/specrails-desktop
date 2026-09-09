# Exclusivamente para agentes: conectar al MCP de Specrails

Usa este procedimiento cuando una persona pida a Claude, Codex, Kimi o Gemini conectarse a Specrails. Completa descubrimiento, registro y una prueba de lectura para el cliente solicitado. No configures los cuatro salvo petición expresa. Si las herramientas ya están cargadas, prueba la conexión existente antes de cambiar nada.

Es un agente externo conectándose a Specrails Desktop, independiente de elegir proveedor de IA dentro de Specrails. Autorizar la conexión no autoriza iniciar misiones, crear specs ni cambiar niveles de permiso. Si no puedes acceder a los archivos locales o a la configuración del cliente, completa las comprobaciones disponibles e indica el paso exacto pendiente.

## Descubre el puente local

Mantén **Specrails Desktop en ejecución en la misma máquina** y MCP habilitado en **Ajustes ▸ MCP**. Usa el puente stdio incluido en Desktop: lee `~/.specrails/mcp.token` localmente. No pegues tokens en conversaciones, logs ni configuración. Esta conexión no necesita el paquete npm antiguo `specrails-mcp` ni su hub.

1. Consulta localmente la entrada existente del cliente solicitado (en Codex, `codex mcp get specrails`). Si ya apunta al puente instalado, consérvala. Mantén los demás servidores y ajustes; nunca reemplaces toda la configuración de Codex. No compartas salidas que contengan credenciales.
2. Abre **Ajustes ▸ MCP ▸ Copiar configuración de cliente** en Specrails. Usa su `command` y cada elemento de `args` por separado. Algunas versiones solo copian `command: "specrails-mcp"`; sirve únicamente si el ejecutable existe en el PATH del cliente. No garantiza que Desktop haya instalado un comando global.
3. Si no se encuentra el comando, localiza `binaries/specrails-mcp.js` y el ejecutable Node incluido en la aplicación instalada. Verifica ambos archivos antes de registrarlos. En Codex, `command` es Node y `args` contiene la ruta del script; no pongas toda una orden de shell en `command`.

| Plataforma | Cómo localizar el puente instalado |
|---|---|
| macOS | Inspecciona el paquete `Specrails.app` instalado. Sus recursos están en `Contents/Resources`; el ejemplo siguiente solo corresponde a `/Applications/Specrails.app`. Otras ubicaciones requieren sus rutas reales. |
| Windows | Busca `binaries/specrails-mcp.js` y el `node.exe` incluido entre los recursos de la instalación. La carpeta varía; conserva cada ruta como un argumento y usa comillas de PowerShell o cadenas literales TOML para las barras inversas. |
| Linux | Busca `binaries/specrails-mcp.js` y Node en los recursos de la instalación o AppImage montada/extraída. Evita rutas de montaje temporales que desaparecen al salir. Si faltan los archivos, indica el bloqueo en lugar de inventar un comando global. |

Dentro de los recursos verificados, busca `binaries/specrails-mcp.js` y `runtimes/node/bin/node` (macOS/Linux) o `runtimes/node/node.exe` (Windows). Si cambia la estructura, limita la búsqueda a la instalación identificada. Son candidatos relativos a los recursos, no ubicaciones universales. Sin acceso al sistema de archivos local, solicita las rutas instaladas o la configuración del cliente sin credenciales.

Para **macOS con esta instalación exacta**, este ejemplo exclusivo para Codex comprueba los archivos antes de registrar el puente. Para otro cliente, usa su registro más abajo. Ejecuta el registro solo si no existe la entrada o si pretendes actualizarla:

```bash
test -x /Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node &&
test -f /Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js &&
codex mcp add specrails -- \
  /Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node \
  /Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js
```

En otras instalaciones, construye la orden con las rutas verificadas: `codex mcp add`, el nombre `specrails`, `--`, la ruta del ejecutable entre comillas y cada argumento entre comillas. Si Codex CLI no está en PATH, localiza su ejecutable instalado o usa la configuración MCP del cliente; no presupongas una ruta universal. Codex usa TOML (`[mcp_servers.specrails]` con `command` y `args`), así que no pegues el JSON `mcpServers` del panel directamente en `config.toml`.

La configuración de usuario predeterminada de Codex es `~/.codex/config.toml`; también puede aplicarse configuración del proyecto en proyectos de confianza. CLI y escritorio pueden reutilizar la entrada si usan la misma configuración local. Comprueba que comparten máquina y directorio de configuración; una tarea en la nube no puede ejecutar tu puente local. Consulta la [documentación oficial de OpenAI sobre MCP](https://developers.openai.com/codex/mcp).

## Registra solo el cliente solicitado

Comprueba versión y ayuda del cliente instalado antes de editar. Prefiere el alcance de usuario para esta app local salvo que se haya pedido alcance de proyecto. Conserva otros servidores, campos, permisos y permisos de archivo. Inspecciona primero la entrada efectiva; si `specrails` ya tiene otro propósito, resuelve la colisión de nombre antes de sustituirla. Para JSON, analiza y combina únicamente `mcpServers.specrails`; un JSON inválido requiere diagnóstico, nunca reiniciar el archivo. Revisa el cambio localmente sin exponer secretos.

| Cliente | Registro y configuración efectiva | Comprobación |
|---|---|---|
| Claude Code | `claude mcp add --scope user --transport stdio specrails --` seguido del ejecutable y argumentos verificados. Las entradas de usuario y locales viven en `~/.claude.json`; las de proyecto en `.mcp.json`. El alcance predeterminado es local: elígelo explícitamente. | `claude mcp get specrails`; `/mcp` en el cliente. La aprobación de proyecto puede impedir la carga. |
| Codex CLI / escritorio | `codex mcp add specrails --` seguido del ejecutable y argumentos verificados. Configuración TOML de usuario, normalmente `~/.codex/config.toml`, compartida por los clientes Codex locales que usen ese directorio. | `codex mcp get specrails`; inspecciona el catálogo real de la conversación. |
| Gemini CLI | `gemini mcp add --scope user --transport stdio specrails` seguido del ejecutable y argumentos verificados. Usa `mcpServers` en `~/.gemini/settings.json`; el alcance de proyecto usa `.gemini/settings.json` y es el predeterminado de CLI. | `gemini mcp list`; `/mcp` en el cliente. Revisa servidores y herramientas permitidos/excluidos. No añadas `--trust` solo para conectar. |
| Kimi Code | Combina la entrada stdio en `~/.kimi-code/mcp.json` (o el `KIMI_CODE_HOME` configurado), o `.kimi-code/mcp.json` del proyecto. El proyecto prevalece sobre el usuario. Kimi Code 0.27.0 **no** ofrece `kimi mcp add`; no lo confundas con el antiguo Kimi CLI de Python. | `/mcp` muestra el estado; `/mcp-config` permite editar interactivamente. Una entrada añadida al archivo requiere una nueva sesión. |

Estas órdenes son **alternativas**, no un script para instalar todos los clientes. Los ejemplos macOS requieren las dos comprobaciones de archivo anteriores y que no exista una entrada en conflicto:

```bash
# Solo Claude Code
claude mcp add --scope user --transport stdio specrails -- \
  /Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node \
  /Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js
```

```bash
# Solo Gemini CLI
gemini mcp add --scope user --transport stdio specrails \
  /Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node \
  /Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js
```

Para Kimi Code, combina este ejemplo macOS en el `mcp.json` elegido conservando el objeto raíz existente y los demás servidores. Usa las rutas verificadas para otras instalaciones:

```json
{
  "mcpServers": {
    "specrails": {
      "command": "/Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node",
      "args": ["/Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js"]
    }
  }
}
```

Claude Desktop es un cliente separado de Claude Code. Si es el destino solicitado, combina esta misma estructura `mcpServers` en su configuración MCP local desde sus ajustes; registrar Claude Code no demuestra que Claude Desktop esté configurado.

Fuentes: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/), [Kimi Code MCP](https://moonshotai.github.io/kimi-code/en/customization/mcp). También se contrastaron las órdenes con la ayuda instalada de Claude Code 2.1.265, Gemini CLI 0.49.0 y Kimi Code 0.27.0. Configuración y conexión real son comprobaciones separadas.

## Verifica las tres etapas

- **Registrado:** la comprobación del cliente solicitado (en Codex, `codex mcp get specrails`) muestra el ejecutable stdio y los argumentos esperados. Solo demuestra que se guardó la configuración.
- **Conectado:** una sesión MCP real completa `initialize`, envía `notifications/initialized` y recibe `tools/list` sin error de protocolo. Inspecciona el catálogo devuelto; el número de herramientas depende de la versión y no concede permiso para todas las acciones.
- **Utilizable en esta conversación:** pide al agente que llame a `specrails_projects` con `{"action":"list"}` y examine el resultado real, incluido `isError`. Es una consulta de lectura. Usa los IDs devueltos en llamadas posteriores y lee `specrails_guide` antes de operar. Una lista vacía sin errores también demuestra conexión.

Si el agente tiene un cliente de protocolo pero no herramientas cargadas, puede hacer la negociación y la consulta de lectura mediante el puente stdio verificado. Debe informar de la conectividad del puente por separado de la disponibilidad en esta conversación. No lances rails ni crees specs para probar la conexión.

## Diagnóstico de conexión

| Síntoma | Comprobación |
|---|---|
| App apagada / conexión rechazada | Abre Specrails y comprueba que MCP está habilitado. Cerrar la ventana puede dejarla en la bandeja; salir de la app detiene el servidor. |
| Comando o script no encontrado | Verifica las rutas reales. Revísalas tras mover o actualizar la app. El comando genérico del panel puede no estar en PATH. |
| Registrado, pero sin herramientas en esta conversación | Revisa el estado MCP del cliente y la configuración efectiva, incluidos servidores/herramientas desactivados y ajustes del proyecto. Guardar una entrada no demuestra que una conversación la haya cargado. Comprueba una nueva sesión local si hace falta; no presupongas una orden de recarga ni prometas actualización automática de la tarea existente. |
| Error de transporte | Ejecuta el puente como stdio; no uses una URL HTTP como ejecutable. Los clientes HTTP directos usan streamable HTTP en la URL `/api/mcp` del panel, no transporte exclusivo SSE. |
| Puerto incorrecto | El puente usa `4200` por defecto; lee `SPECRAILS_MCP_PORT` y después `SPECRAILS_PORT`. Para otro puerto, configura `SPECRAILS_MCP_PORT` en el entorno del servidor con el puerto real. No descubre puertos arbitrarios automáticamente. |
| Token ausente / 401 | Ejecuta el puente con el mismo usuario del sistema que Specrails y comprueba acceso al archivo local sin mostrar su contenido. Si usas `SPECRAILS_REGISTRY_HOME`, debe coincidir con el de la app. Reconecta tras rotar el token. Nunca copies el token maestro `desktop.token`. |
| Error de nivel de permiso | La conexión funciona, pero la acción está restringida. Listar proyectos solo requiere Lectura; habilita otros niveles únicamente para el trabajo previsto. |

## Informa del resultado

Indica cliente y alcance, si reutilizaste o cambiaste la entrada, si funcionaron `initialize` y `tools/list`, y si la conversación actual llamó realmente a `specrails_projects` sin error. Distingue lista vacía de llamada fallida. Señala las etapas no comprobadas y el siguiente paso concreto; no afirmes éxito solo por el registro. No incluyas tokens ni configuraciones privadas completas.
