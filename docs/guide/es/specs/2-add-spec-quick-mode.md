# Añadir spec — Modo Quick

El modo Quick es para cuando ya sabes lo que quieres. Escribes tu idea, la IA redacta la spec completa y esta aterriza en tu tablero como **Por hacer**. Sin idas y venidas: solo descríbela y listo.

## Crear una spec en modo Quick

Para crear una spec rápidamente:

1. En el Dashboard, haz clic en **Añadir** (el botón Más de la barra de herramientas del SpecsBoard).
2. Elige el modo **Quick**.
3. Escribe tu idea en el campo de texto: una frase o un párrafo, lo que la capture.
4. Haz clic para generar.

Mientras se redacta la spec, un pequeño aviso en la esquina muestra el nombre del proyecto, un fragmento de tu idea y el **tiempo transcurrido** («Generando… 0:12»). Cuando termina, el aviso cambia a «Generada en <tiempo>» con una acción **Ver** que te lleva directamente a tu nueva spec.

Ese es todo el flujo. Todo lo que viene a continuación son ajustes opcionales.

## Qué puedes ajustar

**Modelo**: por defecto, la IA elige un modelo razonable. Puedes sobrescribirlo por spec desde el selector de modelo si quieres uno más rápido o más capaz.

**Motor**: si tu proyecto tiene instalado más de un proveedor de IA (cualquier combinación de Claude, Codex y Gemini), un selector de motor aparece en la parte superior del diálogo para que elijas cuál genera esta spec. Tu elección se recuerda por proyecto. Los proyectos con un solo proveedor no muestran esto: no hay entre qué elegir.

**Contexto**: el modo Quick normalmente se ejecuta en un solo turno, porque no necesita leer tu código para escribir una spec a partir de tu descripción. Pero un control deslizante de contexto te permite darle más material con el que trabajar:

- En el nivel más bajo solo lee tu descripción.
- En niveles más altos puede leer tus specs existentes, las specs de OpenSpec de tu proyecto e incluso todo tu código antes de escribir.

Cuanto más contexto le des, más tarda la generación (pasa a varios turnos para poder leer primero), pero la spec vuelve fundamentada en tu proyecto real. Recurre a un contexto más alto cuando la spec necesite referirse a código real, nombres de archivo o comportamiento existente.

**Adjuntos**: arrastra mockups, briefs o archivos de datos al campo de la idea. La IA los lee como parte de la redacción de la spec. (Los adjuntos también hacen que la generación pase a varios turnos.)

**Enriquecer con Contract Layer**: un interruptor que añade un bloque estructurado a la spec generada para que el pipeline posterior no tenga que adivinar nombres ni formas de datos. Es opcional y está desactivado por defecto; tu última elección se recuerda por proyecto. Consulta [Borradores y la Contract Layer](drafts-and-contract-layer.md) para ver qué añade y cuándo merece la pena.

## Cuándo usar el modo Quick frente a Explore

Usa **Quick** cuando la idea ya está clara en tu cabeza: podrías escribir la spec tú mismo, pero prefieres que lo haga la IA. Usa [**Explore**](add-spec-explore-mode.md) cuando todavía le estás dando vueltas y quieres un compañero que te ayude a darle forma.

Una spec creada en modo Quick es una spec totalmente normal: más adelante puedes abrirla y **Seguir editando** en una sesión de Explore si necesita refinarse.

## Adónde ir después

- [Añadir spec — Modo Explore](add-spec-explore-mode.md): para specs que necesitan darse forma.
- [Borradores y la Contract Layer](drafts-and-contract-layer.md): el enriquecimiento con Contract Layer explicado.
- [Ejecutar pipelines](running-pipelines.md): arrastra tu nueva spec a un rail e impleméntala.
