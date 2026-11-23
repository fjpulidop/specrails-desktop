# Analíticas y seguimiento de costes

Cada vez que Specrails ejecuta una CLI de IA en tu nombre —un trabajo del pipeline, una spec rápida, una sesión de Explore, un refinado con IA, un resumen de archivo— deja constancia de lo que ocurrió: qué modelo se ejecutó, cuántos tokens entraron y salieron, cuánto tardó y cuánto costó. La sección **Analíticas** convierte todo eso en un único panel para que siempre sepas adónde va tu gasto en IA.

Ábrela desde la barra lateral derecha (está etiquetada como **Analíticas**). Todo lo que ves está acotado al proyecto en el que estés ahora mismo: cambia de proyecto y los números te siguen.

## Qué cuenta como gasto

Cuenta cada llamada de IA del proyecto: los trabajos del pipeline y los pasos de los loops, la escritura de specs, los resúmenes de archivo, los chats laterales, el diagnóstico de fallos, y las misiones y los turnos de Intent que ejecutas con el agente mientras está fijado a este proyecto. Las misiones de Inicio (sin proyecto fijado) no pertenecen a ningún proyecto y no se cuentan aquí.

Cada llamada se etiqueta con la *superficie* que la generó, y cada superficie pertenece a una de cinco **categorías** que dicen *por qué* se gastó el dinero:

- **Implementación** — construir specs con rails, loops y trabajos.
- **Misiones** — hablar con el agente y el modo Intent (turnos de misión, turnos de Intent y la reescritura de la spec de Intent).
- **Specs** — escribir y refinar specs: specs Quick y Explore, refinado, división, el lanzador de specs, propuestas y triaje.
- **Código** — explicar el código: resúmenes de archivo e historias de archivo.
- **Soporte** — configuración, diagnóstico y chats laterales: análisis de fallos, configuración, Agent Studio y el panel de chat lateral.

## Cómo leer el panel

La página se lee de arriba abajo como *cuánto → en qué y por qué → cuándo → con qué modelos → las llamadas una a una*.

### Cuánto (Hero)

El número grande de la parte superior es tu gasto total del periodo seleccionado, con un delta **vs anterior** para que veas de un vistazo si tu tendencia sube o baja respecto a la ventana previa. Cuando todos los motores están en un plan de suscripción, la cifra se etiqueta como *Estimación equivalente en API*: lo que costarían las llamadas a precios de API, no dinero que se haya cobrado. Si acabas de empezar a usar un proyecto, el estado vacío te indica cuándo empezó el seguimiento.

### En qué se fue el dinero

Una fila por categoría con su coste, su parte del total, el número de llamadas y de tokens, y un motivo de una línea. La parte rayada de una barra es coste estimado (motores que no informan el coste de forma nativa). Abre una categoría para ver las superficies que la componen y haz clic en una para filtrar toda la página por ella. La categoría Misiones también lista tus conversaciones más caras.

### Cronología diaria

Un gráfico de barras apiladas con el gasto por día, desglosado por superficie, con las misiones en su propio color. Los días sin actividad se muestran como cero en lugar de omitirse. Es la forma más rápida de ver *cuándo* se ejecutó un lote costoso.

### Presupuesto

Tus límites diario, semanal, mensual y por ejecución, la proyección a fin de mes y el recálculo «y si» (ver más abajo).

### Motores y modelos

El gasto por motor (en proyectos con más de uno) y tus modelos con más gasto. Haz clic en cualquier modelo para filtrar todo el panel y dejar solo ese modelo.

### Specs principales

Tus diez specs más caras sumando *todas* las superficies a la vez, de modo que una spec que costó poco en Explore y mucho en un trabajo muestra su total real. Los turnos de misión no llevan spec, así que no se listan aquí.

### Tabla de invocaciones en bruto

La verdad sobre el terreno: una fila por llamada. La columna **Motivo** muestra la superficie y su categoría; las filas de misión y de Intent muestran la conversación a la que pertenecen. Este bloque tiene sus propios filtros secundarios que solo afectan a la tabla.

### Más desgloses

Plegados por defecto: el tiempo hasta la decisión y hasta el merge, la economía por loop, la dispersión de coste vs turnos y la comparación Quick vs Explore.

## Filtrado

La cabecera fija lleva los filtros principales —**periodo**, **categoría** y (en proyectos con varios motores) **motor**— y todos se guardan en la URL de la página, así que puedes marcar como favorita o compartir una vista filtrada ("últimos 30 días, solo misiones"). Pasa el ratón por encima de un chip de categoría para ver qué abarca. Se puede seleccionar una única superficie desde la tarjeta *En qué se fue el dinero* (o con `?surface=` en la URL); un chip que se puede quitar en la cabecera la muestra. Los filtros de la tabla en bruto son aparte y se mantienen locales a ese bloque.

Una nota sobre la precisión: las ejecuciones fallidas y abortadas se dejan fuera de las *medias de coste* (distorsionarían los números por ejecución), pero siguen contando para tu número total de ejecuciones y tu tasa de fallos. Así las medias se mantienen limpias mientras la imagen de fiabilidad queda completa.

## Coste por spec

No hace falta ir a la página de Analíticas para ver cuánto costó una spec. Abre cualquier spec y, si tiene gasto asociado, verás un resumen de una línea justo debajo del título:

> $0.42 · 6 turns · 1m 12s active · breakdown

Haz clic y aterrizas en la página de Analíticas ya filtrada por esa spec. Es el camino más rápido entre "¿cuánto me costó esta funcionalidad?" y el desglose completo.

## Todos los proyectos {#all-projects}

Para ver el conjunto de todos los proyectos, abre **Analíticas** desde la barra lateral izquierda o la paleta de comandos. Muestra el coste total, los trabajos y la tasa de éxito, el coste a lo largo del tiempo y una fila por proyecto, y usa las mismas cinco categorías y colores que la página del proyecto. Los turnos de misión y de Intent cuentan en todas las cifras. Los turnos que no pertenecen a ningún proyecto cargado, como las misiones de Inicio y los chats de Blueprint o Builder, se agrupan en una fila **Inicio y Blueprint**, contada en turnos del agente en lugar de trabajos. El coste estimado se marca con `~`, igual que en la página del proyecto.

## Exportar tus datos

Cuando necesites los números fuera de la aplicación —una hoja de cálculo, un informe de finanzas, tu propio análisis— usa el desplegable **Exportar**. Ofrece cuatro formatos:

- **CSV resumen** — un archivo con varias secciones que incluye totales, la cronología diaria, por categoría, por superficie, por modelo y specs principales.
- **JSON resumen** — el mismo resumen, estructurado.
- **CSV en bruto** — cada fila de invocación (hasta 10 000; indica si tuvo que truncar).
- **JSON en bruto** — las mismas filas en bruto, estructuradas.

Las exportaciones respetan los filtros de periodo, categoría y superficie que tengas aplicados en ese momento, y los archivos se nombran de forma que se ordenen con sentido: `<project>-analytics-<period>-<date>.csv`. El botón se deshabilita cuando no hay nada que exportar, y recibirás un aviso de error claro si una descarga falla.

## Siempre al día

No necesitas refrescar. Cuando se registra una nueva invocación en cualquier parte del proyecto, el panel abierto se vuelve a cargar discretamente un instante después, de modo que el medidor de consumo va al ritmo del trabajo a medida que termina.

## Límites diarios {#daily-budget}

Define un límite diario para limitar lo que puede costar un día. Todos los límites (diario, semanal, mensual y por ejecución) se editan en un único sitio: **Analíticas → Presupuesto**. **Ajustes → Avanzado** y **Ajustes del proyecto → Presupuesto** solo muestran el límite diario actual, con un botón **Abrir Presupuesto** que te lleva allí.

Cuando el gasto registrado del día alcanza un límite, la cola se pausa sola, los rails y las ejecuciones de loops se niegan a lanzarse con *Límite diario alcanzado*, y una ejecución de loop en curso se detiene entre pasos, en pausa por el límite. Sube o quita el límite, o espera al reinicio diario, y luego reanuda. Una ejecución de loop retenida solo por el límite diario se reanuda sola cuando el día se reinicia (a medianoche local para el límite de un proyecto, a medianoche UTC para el de toda la app), en cuanto haya capacidad, y lo indica en su registro; eso incluye una ejecución retenida durante la medianoche con la app cerrada, que se reanuda al abrir la app. Una ejecución que pausaste, o una que su propio límite por ejecución (o un límite semanal o mensual) sigue reteniendo, te sigue esperando. Desactívalo en **Ajustes → Avanzado → Reanudar las ejecuciones retenidas por el límite diario cuando se reinicie el día**.

Ambos límites cuentan tu día local, y ambos incluyen el gasto de las misiones: el límite de un proyecto cuenta los turnos fijados a ese proyecto y el de toda la app cuenta todos los turnos. «Hoy» significa tu día local en toda la app: en la barra de estado, en Analíticas y en los límites. La alerta de coste por trabajo es un ajuste aparte.

**Límites semanales, mensuales y por ejecución.** Los límites más largos funcionan igual. Abre **Analíticas → Presupuesto** para fijar un límite **semanal** y uno **mensual**, por proyecto y para toda la app, y un **límite blando por ejecución** (*pausar y preguntar a $X*). Las semanas empiezan el lunes y los meses el día 1, en tu hora local. Un límite semanal o mensual pausa las colas, rechaza lanzamientos y deja en pausa los loops en curso igual que el límite diario; súbelo o bórralo ahí, o espera al reinicio. Un paso que ya ha empezado no se puede detener, así que el límite por ejecución se comprueba **antes de cada paso de IA**, frente a lo que ese paso suele costar: lo que costó antes en la misma ejecución, si no la mediana de sus ejecuciones recientes en el proyecto con el mismo modelo, y si no una estimación de un paso típico de su tipo según la lista de precios. Cuando el siguiente paso no cabe, la ejecución se pausa antes de él y lo explica (*En pausa antes de Developer: suele costar ~$0.45 y quedan $0.12 del límite de $0.40 por ejecución*); **Reanudar** ofrece entonces **ejecutar solo este paso** (el límite vuelve a aplicarse después), continuar sin el límite o subirlo. Una ejecución cuyo coste reportado alcanza el límite se pausa de la misma manera. Son estimaciones: un paso que cuesta mucho más de lo habitual todavía puede superar el límite. Alcanzar cualquier límite añade además un elemento **Subir límite** a la bandeja.

El panel de Presupuesto muestra hoy, esta semana y este mes frente a cada límite. Su **proyección** a fin de mes es una estimación (la media de los últimos 14 días completos por los días que quedan, más lo que ya has gastado) y nunca se suma al gasto facturado. **Y si** vuelve a calcular los últimos 30 días de uso de tokens registrado con otro modelo usando la lista de precios de la app, y dice *Sin precio* si no tiene precio para un modelo. Con un plan de suscripción no hay coste en dólares por uso, así que el panel muestra turnos y límites del plan en lugar de dólares.
