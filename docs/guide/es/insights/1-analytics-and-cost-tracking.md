# Analíticas y seguimiento de costes

Cada vez que Specrails ejecuta una CLI de IA en tu nombre —un job del pipeline, una spec rápida, una sesión de Explore, un refinado con IA, un resumen de archivo— deja constancia de lo que ocurrió: qué modelo se ejecutó, cuántos tokens entraron y salieron, cuánto tardó y cuánto costó. La sección **Analíticas** convierte todo eso en un único panel para que siempre sepas adónde va tu gasto en IA.

Ábrela desde la barra lateral derecha (está etiquetada como **Analíticas**). Todo lo que ves está acotado al proyecto en el que estés ahora mismo: cambia de proyecto y los números te siguen.

## Qué cuenta como gasto

Specrails registra cinco tipos de actividad de IA, llamados *superficies*. Cada uno tiene un color asignado de forma consistente en todas las gráficas, para que lo identifiques de un vistazo:

- **Job** — un rail del pipeline ejecutando Architect → Developer → Reviewer → Ship.
- **Quick spec** — una spec generada por la vía rápida de Add Spec.
- **Explore spec** — una conversación de Explore en la que das forma a una spec charlando.
- **AI edit** — un refinado asistido por IA sobre un agente o un archivo.
- **File summary** — los resúmenes en lenguaje sencillo que alimentan el Code explorer.

Hay un par de cosas que, a propósito, *no* se registran: el panel de chat lateral y el asistente de configuración también lanzan CLIs de IA, pero nunca aparecen en tu gasto. Así el panel refleja trabajo real y repetible, en lugar de conversaciones puntuales.

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
