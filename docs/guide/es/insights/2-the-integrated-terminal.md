# El terminal integrado

Specrails tiene un terminal de verdad integrado: el panel que sube desde la parte inferior de la ventana, igual que el de VS Code o Cursor. Ejecuta tu shell real, en el directorio real de tu proyecto, así que puedes usar `git`, `npm`, tests o cualquier otra cosa sin salir de la aplicación.

## Abrirlo y cerrarlo

La forma más rápida es el teclado: **Cmd+J** (macOS) o **Ctrl+J** (Windows/Linux) abre y cierra el panel, y enfoca el terminal en cuanto aparece para que puedas empezar a escribir de inmediato. También puedes usar el chevron de la barra de estado.

El panel tiene tres estados:

- **Oculto** — guardado a un lado.
- **Restaurado** — el panel normal, a media altura.
- **Maximizado** — ocupando el área de trabajo cuando necesitas espacio para leer la salida.

Minimizar el panel (el chevron) **no** detiene nada: tus shells siguen ejecutándose en segundo plano. Lo único que termina de verdad una sesión es cerrarla (el icono de la papelera, o la ✕ de cada pestaña).

## Varias sesiones

Puedes tener varios terminales a la vez en el mismo proyecto: hasta diez. Cada uno tiene su propia pestaña; puedes renombrarlos para no confundir "dev server" con "tests". Todos arrancan en la carpeta de tu proyecto y cargan tu perfil de shell (`.zshrc`, `.bashrc`, etc.), así que tus alias y tu PATH son exactamente los que esperarías.

Y aquí viene lo importante: tus terminales **sobreviven a los cambios de proyecto y de pestaña**. Specrails mantiene cada sesión viva e intacta entre bambalinas —scrollback, procesos en ejecución, todo— de modo que saltar a Analíticas y volver no reinicia tu shell ni interrumpe un comando que esté tardando. Las sesiones solo terminan cuando las cierras explícitamente (o cuando eliminas todo el proyecto).

## Por proyecto, recordado

Si el panel está abierto, cuánto lo has arrastrado de alto, qué pestañas existen: todo eso se recuerda **por proyecto**. Vuelve a un proyecto y lo encontrarás tal como lo dejaste.

## Las funciones premium

Esto no es una consola pelada. El terminal viene con los detalles que querrías de uno de primera:

- **Renderizado rápido y nítido** mediante WebGL (con un repliegue automático para que nunca se rompa), gestión completa del ancho Unicode y ligaduras de fuente.
- **Busca en tu scrollback** con **Cmd+F** — genial para encontrar ese error enterrado 500 líneas más arriba.
- **Zoom de fuente** con **Cmd+=**, **Cmd+-** y **Cmd+0** para restablecer.
- **Atajos de portapapeles** — Cmd+C / Cmd+V para copiar y pegar, Cmd+K para limpiar — más un menú contextual con clic derecho.
- **Arrastrar y soltar rutas de archivo** (en la aplicación de escritorio): suelta un archivo sobre el terminal y su ruta se inserta, correctamente entrecomillada para tu shell.
- **Redimensionado suave** — arrastrar la altura del panel o plegar la barra lateral no provocará saltos en la salida.
- **Imágenes en línea** — los terminales que emiten imágenes tipo Sixel o iTerm2 las renderizan ahí mismo.
- **Integración con el shell** — Specrails sabe dónde empieza y termina cada comando, así que puede llevar tu historial de comandos y avisarte cuando un comando largo termina (una notificación de escritorio, con repliegue al navegador). Si tu shell no puede instrumentarse por algún motivo, degrada en silencio y te lo dice una vez.

## Ajustes

Las preferencias del terminal viven en dos capas: un valor por defecto para toda la aplicación y una anulación opcional por proyecto. El ajuste por proyecto gana cuando existe, así que puedes mantener un aspecto global mientras retocas un proyecto que necesite algo distinto.

## Desactivarlo

El terminal está activado por defecto. Si prefieres no tenerlo, puede desactivarse mediante los flags `VITE_FEATURE_TERMINAL_PANEL` (cliente) o `SPECRAILS_TERMINAL_PANEL` (servidor) — pon cualquiera de los dos a `false`. La mayoría de la gente simplemente lo dejará activado.
