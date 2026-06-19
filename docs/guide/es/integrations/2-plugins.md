# Plugins (Integraciones)

La sección **Integraciones** es un marketplace por proyecto de complementos opcionales que amplían lo que la IA puede hacer. Cada proyecto decide de forma independiente qué plugins quiere: instalar un plugin en un proyecto nunca afecta a otro.

Los plugins funcionan registrando discretamente un **servidor MCP** (Model Context Protocol) en tu proyecto, lo que da a la IA nuevas herramientas para usar durante los rails y el chat. No necesitas entender MCP para usarlos: instálalos y estarán disponibles la próxima vez que se ejecute un rail.

## Qué hay disponible hoy

Esta versión se distribuye **solo con plugins incluidos**: los plugins que puedes instalar son los que vienen integrados en la app. No hay registro remoto, ni plugins subidos por usuarios, ni carga de código de terceros, así que todo lo del catálogo está revisado y se distribuye con Specrails.

El plugin estrella es:

- **Serena** — navegación semántica de código. Le da a la IA una comprensión de tu código respaldada por un language server (saltar a la definición, buscar referencias, búsqueda consciente de símbolos) en lugar de simple coincidencia de texto. Ideal para repos grandes o desconocidos en los que quieres que el agente razone sobre símbolos reales.

  Serena requiere la herramienta `uv` en tu `PATH` (se ejecuta a través de `uvx`). La app detecta automáticamente si `uv` está presente y te avisa si falta.

## Instalar un plugin

1. Abre **Integraciones** desde la barra lateral derecha.
2. Encuentra el plugin en el catálogo. Cada tarjeta muestra un estado: **No instalado**, **Instalado**, **Degradado** u **Huérfano**.
3. Entra en el plugin para **previsualizar la instalación**: esto te muestra exactamente qué archivos cambiarán antes de que ocurra nada.
4. Haz clic en **Instalar**. Verás el progreso en directo mientras se configura.

Por debajo, la instalación es *quirúrgica y aditiva*: solo añade sus propias entradas al `.mcp.json` de tu proyecto (y, para algunos plugins, un archivo de fragmento en el espacio protegido `.claude/agents/`). Nunca reescribe tu configuración por completo, y añadir un segundo plugin nunca puede alterar el primero. Si la instalación no puede verificarse como saludable, se revierte de forma limpia.

## Gestionar los plugins instalados

- **Salud.** Cada plugin tiene una comprobación de salud bajo demanda. Un plugin que se instala bien pero que más tarde no puede arrancar se marca como **Degradado**: no bloqueará tus rails, simplemente verás la insignia y un motivo.
- **Desinstalar.** Quitar un plugin elimina quirúrgicamente solo las entradas que le pertenecen, dejando intacto el resto de tu configuración.
- **Huérfanos.** Si los archivos de un plugin quedan abandonados sin un estado correcto (por ejemplo, tras un cambio interrumpido), aparece como **Huérfano** y puedes limpiarlo con un clic.

## Cómo aparecen los plugins en tu trabajo

- **Rails.** Antes de que un rail se ejecute, Specrails comprueba qué plugins están instalados y saludables, y pone esas herramientas a disposición del agente para ese trabajo. Un plugin degradado simplemente se omite para esa ejecución: el rail se lanza igualmente con normalidad. Cada trabajo registra una instantánea de qué plugins estaban activos, que puedes ver en la exportación de diagnóstico del trabajo.
- **Chat.** El chat recoge automáticamente la configuración MCP de tu proyecto, así que los plugins instalados también están disponibles ahí.
- **Configuración.** Los plugins se ignoran mientras un proyecto todavía se está configurando; entran en juego una vez que el proyecto está listo.

## Notas sobre proveedores

Los plugins son conscientes del proveedor. Serena y otros plugins MCP similares se resuelven para los proveedores que registran MCP a través del `.mcp.json` del proyecto (Claude y Gemini). Para los proyectos con Codex, los servidores MCP se gestionan en cambio a través de la propia configuración global de Codex, así que las entradas de plugins en **Integraciones** se filtran en consecuencia. La tarjeta de Jira en Integraciones es independiente del proveedor y se muestra para todos: consulta la guía de Jira.

## Archivos reservados

Los plugins gestionan un conjunto pequeño y bien definido de archivos en tu proyecto: tu `.mcp.json` (mezclado quirúrgicamente), algo de estado bajo `.specrails/plugins/` y fragmentos de agente por plugin en `.claude/agents/custom-<plugin>.md`. Estos son activos de equipo que puedes commitear si quieres compartir una integración con tus compañeros: la app nunca los sobrescribe a ciegas.
