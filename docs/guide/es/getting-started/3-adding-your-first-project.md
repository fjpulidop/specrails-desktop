# Añadir tu primer proyecto

Un proyecto no es más que una carpeta de tu ordenador que contiene una base de código. Vamos a conectar una.

## Abre el diálogo de Añadir proyecto

Haz clic en **Añade tu primer proyecto** en la pantalla de bienvenida (o en el botón **Añadir proyecto** de la barra lateral izquierda más adelante). Aparece un pequeño diálogo.

## Rellena los datos

**Carpeta del proyecto** *(obligatorio)*

Indica a specrails la carpeta que contiene tu código. En la app de escritorio puedes hacer clic en el icono de carpeta para navegar y elegirla visualmente, o pegar la ruta completa. Debe ser la raíz de tu repositorio: la carpeta que contiene tu código y (normalmente) un directorio `.git`.

**Nombre del proyecto** *(opcional)*

Una etiqueta amigable que se muestra en la barra lateral. Si lo dejas en blanco, specrails usa el nombre de la carpeta.

> Una comprobación rápida se ejecuta en segundo plano para confirmar que las herramientas necesarias están presentes. Si falta algo esencial, el botón **Añadir** permanece deshabilitado y un enlace **Más info** te da los comandos de instalación exactos.

Ese es todo el formulario — haz clic en **Añadir** y listo.

## Los proveedores de IA se detectan automáticamente

Ya no eliges proveedores. Specrails detecta cada CLI de IA instalado en tu máquina — **Claude**, **Codex**, **Gemini**, **Kimi** — y todos los proyectos pueden usarlos todos, siempre. Si instalas un proveedor nuevo más adelante, aparece en todas partes por sí solo la próxima vez que vuelvas a la app; sin re-configuración, sin ajustes por proyecto. Si un proveedor está instalado pero sin sesión iniciada, su selector muestra una insignia sutil *Sin iniciar sesión*.

## La configuración ocurre en silencio

No hay asistente de configuración. En el momento en que haces clic en **Añadir**, el proyecto queda registrado y aparece en tu barra lateral — puedes abrirlo de inmediato. En segundo plano, specrails ensambla el workspace del proyecto (unos segundos, totalmente offline): un pequeño punto parpadeante en la fila del proyecto indica que está trabajando, y desaparece cuando todo está listo. Si algo falla para un proveedor, el proyecto sigue funcionando con los demás — aparece un punto ámbar y, al hacer clic, se reintenta.

## Qué se instala — y dónde

La configuración es deliberadamente **no invasiva**: tu repositorio permanece intacto. Todos los artefactos de specrails (definiciones de agentes, comandos, perfiles, ajustes locales) viven en un workspace por proyecto bajo tu directorio home, enlazado a una única instalación compartida del framework que viene con la app. Tu repo nunca se modifica — y cuando la app se actualiza, todos los proyectos reciben el nuevo framework automáticamente, a la vez.

> **¿Prefieres la configuración profunda?** La app incluye a propósito la instalación rápida con plantillas. Si prefieres el flujo enriquecido con IA (análisis del código base y personas de agentes personalizadas), puedes ejecutar `npx specrails-core@latest init` desde la carpeta de tu proyecto en un terminal.

## Ya estás dentro

El panel del proyecto está disponible en cuanto haces clic en **Añadir**. Es hora del recorrido — consulta [El recorrido por el panel](the-dashboard-tour).
