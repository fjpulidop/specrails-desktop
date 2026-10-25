# Analíticas y seguimiento de costes

Cada vez que Specrails ejecuta una CLI de IA en tu nombre —un job del pipeline, una spec rápida, una sesión de Explore, un refinado con IA, un resumen de archivo— deja constancia de lo que ocurrió: qué modelo se ejecutó, cuántos tokens entraron y salieron, cuánto tardó y cuánto costó. La sección **Analíticas** convierte todo eso en un único panel para que siempre sepas adónde va tu gasto en IA.

Ábrela desde la barra lateral derecha (está etiquetada como **Analíticas**). Todo lo que ves está acotado al proyecto en el que estés ahora mismo: cambia de proyecto y los números te siguen.

## Qué cuenta como gasto

Specrails etiqueta cada ejecución de IA con una *superficie*: la parte de la app que generó el gasto. Las superficies principales tienen un color fijo y su propio chip de filtro, para que las identifiques de un vistazo:

- **Job** — un job del pipeline en cola (Architect → Developer → Reviewer → Ship), incluidas las ejecuciones Freestyle.
- **Loop** — cada paso de IA de una ejecución de loop. Los rails se ejecutan como loops por defecto, así que la mayor parte del gasto de los rails aparece aquí.
- **Quick spec** — una spec generada por la vía rápida de Add Spec.
- **Explore spec** — una conversación de Explore en la que das forma a una spec charlando.
- **AI edit** — un refinado asistido por IA sobre un agente o un archivo.
- **SMASH** — dividir una spec épica en specs más pequeñas.
- **File summary** — los resúmenes en lenguaje sencillo y las historias de archivo que alimentan el Code explorer.

También se registran superficies menores, sin chip propio: el panel de chat lateral, el lanzador de specs de OpenSpec, las propuestas de specs, Agent Studio y el chat de configuración heredado. Las misiones fijadas al proyecto también cuentan en su gasto. No se deja fuera nada que ejecute una CLI de IA, así que los totales reflejan toda la actividad de IA del proyecto.

## Cómo leer el panel

La página se compone de unos cuantos bloques, de arriba abajo:

### El medidor de consumo (Hero)

El número grande de la parte superior es tu gasto total del periodo seleccionado, con un delta **vs anterior** para que veas de un vistazo si tu tendencia sube o baja respecto a la ventana previa. Si acabas de empezar a usar un proyecto, el estado vacío te indica cuándo empezó el seguimiento ("Seguimiento iniciado el YYYY-MM-DD"): no hay relleno retroactivo de datos históricos, así que el medidor solo conoce las ejecuciones que ocurrieron mientras usabas esta versión.

### Cronología diaria

Un gráfico de barras apiladas con el gasto por día, desglosado por superficie. Los días sin actividad se muestran como cero en lugar de omitirse, para que la forma de tu semana sea honesta. Es la forma más rápida de ver *cuándo* se ejecutó un lote costoso.

### Quick vs Explore

Una tarjeta que compara codo con codo tus dos estilos de creación de specs. Si has hecho menos de cinco sesiones de Explore, muestra una invitación amable en lugar de medias engañosas: las muestras pequeñas no sirven para comparaciones fiables.

### Por modelo

Tus modelos con más gasto (hasta diez). Haz clic en cualquier modelo para filtrar todo el panel y dejar solo ese modelo: muy útil cuando quieres saber cuánto te está costando de verdad un modelo de gama alta concreto.

### Dispersión de coste vs turnos

Cada punto es una invocación, situando el coste frente al número de turnos. Los valores atípicos —las ejecuciones caras y con muchos turnos— saltan a la vista enseguida. (La dispersión muestra tus 500 puntos más recientes para seguir siendo ágil.)

### Tickets principales

Tus diez tickets más caros sumando *todas* las superficies a la vez, de modo que un ticket que costó poco en Explore y mucho en un job muestra su total real. Los tickets eliminados y las ejecuciones sin atribuir tienen su propio grupo, así que nada desaparece en silencio de los totales.

### Tabla de invocaciones en bruto

La verdad sobre el terreno: una fila por invocación. Este bloque tiene sus propios filtros secundarios que solo afectan a la tabla, así que puedes profundizar sin alterar las gráficas de arriba.

## Filtrado

La cabecera fija de la parte superior lleva los dos filtros principales —**periodo** y **superficie**— y ambos se guardan en la URL de la página. Eso significa que puedes marcar como favorita o compartir una vista filtrada ("últimos 30 días, solo jobs") y se reabrirá exactamente como la dejaste. Los filtros de la tabla en bruto son aparte y se mantienen locales a ese bloque.

Una nota sobre la precisión: las ejecuciones fallidas y abortadas se dejan fuera de las *medias de coste* (distorsionarían los números por ejecución), pero siguen contando para tu número total de ejecuciones y tu tasa de fallos. Así las medias se mantienen limpias mientras la imagen de fiabilidad queda completa.

## Coste por ticket

No hace falta ir a la página de Analíticas para ver cuánto costó una spec. Abre cualquier ticket y, si tiene gasto asociado, verás un resumen de una línea justo debajo del título:

> $0.42 · 6 turns · 1m 12s active · breakdown

Haz clic y aterrizas en la página de Analíticas ya filtrada por ese ticket. Es el camino más rápido entre "¿cuánto me costó esta funcionalidad?" y el desglose completo.

## Exportar tus datos

Cuando necesites los números fuera de la aplicación —una hoja de cálculo, un informe de finanzas, tu propio análisis— usa el desplegable **Exportar**. Ofrece cuatro formatos:

- **CSV resumen** — un archivo con varias secciones que incluye totales, la cronología diaria, por superficie, por modelo y tickets principales.
- **JSON resumen** — el mismo resumen, estructurado.
- **CSV en bruto** — cada fila de invocación (hasta 10 000; indica si tuvo que truncar).
- **JSON en bruto** — las mismas filas en bruto, estructuradas.

Las exportaciones respetan los filtros de periodo y superficie que tengas aplicados en ese momento, y los archivos se nombran de forma que se ordenen con sentido: `<project>-analytics-<period>-<date>.csv`. El botón se deshabilita cuando no hay nada que exportar, y recibirás un aviso de error claro si una descarga falla.

## Siempre al día

No necesitas refrescar. Cuando se registra una nueva invocación en cualquier parte del proyecto, el panel abierto se vuelve a cargar discretamente un instante después, de modo que el medidor de consumo va al ritmo del trabajo a medida que termina.

## Presupuestos diarios {#daily-budget}

Define un presupuesto diario para limitar lo que puede costar un día. Todos los límites (diario, semanal, mensual y por ejecución) se editan en un único sitio: **Analíticas → Presupuesto**. **Ajustes → Avanzado** y **Ajustes del proyecto → Presupuesto** solo muestran el límite diario actual, con un botón **Abrir Presupuesto** que te lleva allí.

Cuando el gasto registrado del día alcanza un límite, la cola se pausa sola, los rails y las ejecuciones de loops se niegan a lanzarse con *Límite diario alcanzado*, y una ejecución de loop en curso se detiene entre pasos, en pausa por el límite. Sube o quita el límite, o espera al reinicio diario, y luego reanuda.

El límite del proyecto cuenta tu día local; el de toda la app cuenta el día UTC. La alerta de coste por trabajo es un ajuste aparte.

**Límites semanales, mensuales y por ejecución.** Los límites más largos funcionan igual. Abre **Analíticas → Presupuesto** para fijar un límite **semanal** y uno **mensual**, por proyecto y para toda la app, y un **límite blando por ejecución** (*pausar y preguntar a $X*). Las semanas empiezan el lunes y los meses el día 1, en tu hora local. Un límite semanal o mensual pausa las colas, rechaza lanzamientos y deja en pausa los loops en curso igual que el límite diario; súbelo o bórralo ahí, o espera al reinicio. Cuando el coste reportado de una ejecución alcanza el límite por ejecución, se pausa, y **Reanudar** pregunta si continuar sin el límite o subirlo. Alcanzar cualquier límite añade además un elemento **Subir límite** a la bandeja.

El panel de Presupuesto muestra hoy, esta semana y este mes frente a cada límite. Su **proyección** a fin de mes es una estimación (la media de los últimos 14 días completos por los días que quedan, más lo que ya has gastado) y nunca se suma al gasto facturado. **Y si** vuelve a calcular los últimos 30 días de uso de tokens registrado con otro modelo usando la lista de precios de la app, y dice *Sin precio* si no tiene precio para un modelo. Con un plan de suscripción no hay coste en dólares por uso, así que el panel muestra turnos y límites del plan en lugar de dólares.
