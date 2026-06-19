# Añadir tu primer proyecto

Un proyecto no es más que una carpeta de tu ordenador que contiene una base de código. Vamos a conectar una.

## Abre el diálogo de Añadir proyecto

Haz clic en **Añadir tu primer proyecto** en la pantalla de bienvenida (o, más adelante, en el botón **Añadir proyecto** de la barra lateral izquierda). Aparece un pequeño diálogo.

## Rellena los datos

**Carpeta del proyecto** *(obligatorio)*

Apunta specrails a la carpeta que contiene tu código. En la app de escritorio puedes hacer clic en el icono de carpeta para explorar y seleccionarla visualmente, o pegar la ruta completa. Debería ser la raíz de tu repositorio: la carpeta que contiene tu código y (normalmente) un directorio `.git`.

**Nombre del proyecto** *(opcional)*

Una etiqueta amigable que se muestra en la barra lateral. Si lo dejas en blanco, specrails usa el nombre de la carpeta.

**Providers**

Elige qué provider(s) de IA debería usar este proyecto. specrails te muestra los que ha detectado en tu máquina:

- 🤖 **Claude**
- ⚡ **Codex**
- ✨ **Gemini**

Los providers que no ha encontrado aparecen en gris y marcados como *no encontrado*: instala uno e inicia sesión, y luego vuelve a abrir el diálogo. Por defecto, todos los providers disponibles vienen preseleccionados, pero puedes deseleccionar hasta quedarte solo con el que quieras. Si eliges más de uno, el **primero** se convierte en el predeterminado del proyecto; más adelante podrás escoger según la tarea.

> Una comprobación rápida se ejecuta en segundo plano para confirmar que las herramientas necesarias están presentes. Si falta algo esencial, el botón **Añadir** permanece deshabilitado y un enlace de **Más información** te da los comandos exactos de instalación.

Haz clic en **Añadir** para continuar.

## Una configuración que se hace en segundos

Si la carpeta ya tiene specrails configurado, has terminado: el proyecto aparece en tu barra lateral al instante.

Si es un proyecto nuevo, se ejecuta un breve **asistente de configuración**. Tiene tres pasos:

1. **Configurar** — confirma lo básico para cada provider que hayas elegido.
2. **Instalar** — specrails configura el proyecto automáticamente. Es la instalación *rápida*: agentes de plantilla listos para usar que quedan en su sitio en segundos. Verás un log en directo mientras se ejecuta.
3. **Hecho** — un resumen que confirma que todo está listo.

En un proyecto con varios providers, la instalación se ejecuta una vez por provider, uno tras otro, y el paso Hecho muestra una tarjeta para cada uno.

## Qué se instala

La configuración es deliberadamente ligera y **no invasiva**. specrails añade una pequeña cantidad de configuración a tu proyecto para que el pipeline sepa cómo ejecutarse:

- Una carpeta `.specrails/` que guarda los perfiles de agente y los ajustes locales de tu proyecto.
- Definiciones de agentes en `.claude/agents/` que dan vida al pipeline Architect → Developer → Reviewer → Ship.

Eso es todo: specrails no reescribe tu código fuente durante la configuración, y estos archivos se pueden hacer commit sin problema si quieres compartir la configuración con tu equipo.

> **¿Prefieres la configuración a fondo?** La app incluye a propósito la instalación rápida desde plantillas. Si prefieres el flujo enriquecido con IA (análisis de la base de código y personas de agente personalizadas), puedes ejecutar `npx specrails-core@latest init` desde la carpeta de tu proyecto en una terminal.

## Ya estás dentro

Cuando termine la configuración, specrails te lleva directamente al dashboard de tu proyecto. Es hora del recorrido: consulta [El recorrido por el dashboard](the-dashboard-tour).
