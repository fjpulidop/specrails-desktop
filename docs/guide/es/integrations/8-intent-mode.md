# Intent: di el problema, no la solución {#intent-mode}

Escribir código ya no es lo lento al construir software. Lo lento es saber qué construir y comprobar que se construyó bien. Intent parte de ahí. Escribes el **intent**: el problema, el resultado que quieres, cómo sabrás que funcionó, a quién y a qué afecta, los límites y lo que todavía nadie sabe. No escribes la solución. Specrails deriva la spec de tu intent y tú revisas la spec en lugar de escribirla.

A partir de un intent hay dos caminos iguales:

- **Explorar**: constrúyelo junto a un agente en una sesión de Intent aislada (su propia rama, una copia aparte de tu proyecto). Cuando el resultado es el bueno, un rail deriva la spec de lo que construiste.
- **Delegar**: el agente escribe la spec a partir del intent, tú la revisas y un rail la construye.

Explorar sirve para descubrir; Delegar, para construir lo que ya está claro. Ninguno se recomienda: eliges tú.

## El intent

Un intent tiene seis partes, y ninguna para la solución:

| Parte | Qué lleva |
| --- | --- |
| **Problema** | Qué falla hoy, para quién y cuándo duele. |
| **Resultado buscado** | Qué es cierto cuando está resuelto. Una **hipótesis** opcional se lee *Creemos que … producirá …; sabremos que funcionó cuando …*. |
| **Cómo sabremos** | Señales observables de que el resultado se logró («un usuario nuevo termina la configuración en menos de 2 minutos»). Se convierten en criterios de aceptación. |
| **A quién y a qué afecta** | Personas, pantallas o sistemas. |
| **Restricciones** | Límites que cualquier solución debe respetar. |
| **Preguntas abiertas** | Lo que todavía nadie sabe. Los agentes las investigan en lugar de adivinar. |

Si nombras una solución («añadir una caché Redis»), el intent conserva para qué sirve («la API responde en menos de 200 ms») como resultado buscado, y tu solución pasa a ser una restricción (la exiges) o una pregunta abierta (es una opción más).

Cada spec puede llevar un intent. Está encima de la descripción en el detalle de la spec, donde puedes editar cada parte. Las preguntas abiertas respondidas muestran su respuesta. Una spec cuyo intent aún tiene preguntas abiertas muestra en el board una pequeña brújula con su número. El intent se queda en Specrails, igual que **Fuera de alcance**, y nunca se escribe en Jira.

## De dónde viene un intent

- **En una misión (lo habitual).** Cuando describes un trabajo, el agente te entrevista como un analista. Pregunta por los usuarios, los límites y cómo sabrás que funcionó, y muestra una tarjeta **Intent** con cada parte y dos lecturas de tu petición. Haz clic en una lectura para responder, o contesta con tus palabras. Cuando el intent está asentado, la tarjeta ofrece **Explorar** y **Delegar** lado a lado. La spec que el agente escribe a partir de él lleva el intent automáticamente. Para saltarte el paso del intent en una misión, envía `#noframe`; `#frame` lo vuelve a activar.
- **En Añadir spec.** **Intent** es el primer modo y se abre por defecto. Describe el problema, no la solución, y pulsa **Generar intent y spec**. Una sola pasada de IA escribe el intent y después la spec derivada de él, lista para que la revises. Quick, Explore y Raw siguen ahí. Si no se puede escribir el intent, recibes igualmente la spec, sin intent, y un aviso lo indica.

## El intent viaja con el trabajo

- Todo agente que trabaja en la spec recibe primero el intent, marcado como fuente de verdad del *porqué* y del *resultado buscado*, nunca del *cómo*. Eso incluye al planificador, al desarrollador, al revisor y al agente de la sesión de Intent. El revisor también juzga el trabajo frente al resultado buscado y a las señales.
- Cuando un rail entrega una spec que tiene intent, Specrails lo escribe como `intent.md` en el cambio de OpenSpec de la ejecución, junto a su propuesta, su diseño y sus tareas. Así el intent vive en Git con el código. (Una ejecución por lotes que abarca varias specs no escribe ninguno.)

## Explorar: empezar una sesión de Intent

Elige **Explorar** en una tarjeta de intent asentado. Se abre una confirmación: Specrails crea una copia aparte del proyecto en su propia rama de Intent, donde el agente puede escribir código, y tu rama principal no se toca. Pulsa **Empezar Intent**. En el board aparece una spec provisional con tu intent y la etiqueta **En Intent** (haz clic en ella para volver a la misión), y el primer turno del agente parte del intent.

## Empezar un Intent desde una spec que ya tienes

Cualquier spec se puede construir en Intent, no solo una idea nueva. Intent e Implement siguen siendo dos formas iguales de trabajarla:

- en el tablero, haz clic derecho en una spec y elige **Empezar en Intent** (junto a arrastrarla a un rail); en el detalle de la spec, **Empezar en Intent** está junto a **Mover a rail**;
- en una misión, cuando pides implementar una spec sin nombrar un rail, el agente muestra una tarjeta de dos caminos para esa spec: **Intent** la trabaja contigo y **Spec + Implement** la lanza en un rail;
- una tarjeta de lanzamiento en rail de una sola spec también ofrece **Empezar en Intent** junto a su lanzamiento.

La propia spec pasa a **En Intent**: no se crea ninguna spec provisional y el primer turno del agente recibe la spec (su intent primero y luego sus criterios de aceptación, la Contract Layer, lo que queda fuera de alcance y los addenda abiertos). Si la empiezas desde el tablero, el Intent se abre en la misión de la propia spec o en una misión nueva con el nombre de la spec. En un proyecto con varios repositorios Git, cuando la spec no indica exactamente uno de ellos, un pequeño diálogo pregunta antes dónde se ejecuta el Intent: solo aparecen los repositorios Git, viene preseleccionado el repositorio de la spec (o, si no, el principal) y las flechas cambian la elección. **Empezar en Intent** aparece desactivado, con el motivo al pasar el ratón, cuando la spec ya está en Intent, está hecha o cancelada, está en un rail o Intent no está disponible.

**Descartar** devuelve la spec tal como estaba, con su estado anterior: tu spec nunca se borra. Cuando el Intent se entrega, la spec se reescribe a partir de lo construido y antes se guarda su texto original como comentario, **Original spec before Intent**, para que no se pierda nada. El propio intent nunca se reescribe: solo sus preguntas abiertas ganan las respuestas que el trabajo resolvió. Una spec ya enlazada con Jira actualiza esa misma incidencia y la mueve al estado asignado a revisión; no se crea una segunda.

## Mientras estás en Intent

El modo Intent se nombra allí donde miras, con su propio color de Intent: el compositor muestra un chip **Intent** junto al de autonomía y la pista *Dile al agente qué cambiar en este Intent…*; el título de la misión indica **En Intent**, igual que su fila en la lista de misiones. La conversación marca dónde entraste y saliste de Intent, y las respuestas del agente escritas en Intent llevan una pequeña marca **Intent** junto a su hora.

La franja justo encima del compositor muestra el Intent en una fila corta: su estado, **Intent · 7 archivos**, **Pausar Intent** y la acción principal, **Pasar a un rail**. Cuando una acción no está disponible (el Intent aún está guardando, hay otra acción en curso), al pasar el ratón dice por qué. Abre la fila con su flecha, como cualquier otra ejecución, para ver el resto:

- la **rama** (pulsa para copiar su nombre), los **cambios** con líneas añadidas y eliminadas (pulsa para ver cada archivo con su estado y +/−) y el **coste hasta ahora** según factura el proveedor. Muestra `—` hasta que un turno tiene coste informado, y nunca una estimación; un `*` marca un total que deja fuera turnos sin precio, con una nota que dice cuántos;
- **Vista previa** mientras la app del Intent está en marcha (ver más abajo);
- **Descartar**, aparte, borra los cambios del Intent, su rama y la spec provisional. La confirmación enumera lo que pierdes: los archivos cambiados con sus +/−, la rama y la spec.

**Pausar Intent** detiene al agente y conserva tus cambios y la spec. La fila muestra entonces **Reanudar Intent**.

Puedes escribir mientras el agente trabaja: en Intent tu mensaje **interrumpe** el paso actual (el botón de enviar se convierte en un rayo) y el agente sigue al momento con tu nueva información. Mientras el Intent está abierto, la franja de git bajo el compositor se aparta: el panel del Intent ya muestra su rama.

## Prueba la app

El agente de Intent ejecuta él mismo el typecheck y los tests para comprobar su trabajo. Cuando hay algo que probar, te pregunta con tres opciones: **Start the app**, **Start and expose on the local network** o **Not now**. Exponerla te permite abrir la app desde un móvil en la misma Wi-Fi o VPN, y cualquiera en esa red puede acceder a ella.

Cuando la app escucha, el agente te da sus direcciones como enlaces y el panel del Intent muestra **Vista previa** con un punto verde: abre la app en tu navegador. Su menú tiene la dirección de red y **Detener app**. La app se ejecuta desde la copia del Intent, nunca desde tu checkout principal, y Specrails la detiene cuando pausas, descartas o entregas el Intent.

## Pasar a un rail {#intent-hand-off}

Cuando el resultado te convenza, pulsa **Pasar a un rail**. La fila pasa a **Listo para convertirse en un PR** y abre una sola línea encima: *Rail 2 convertirá tus 7 archivos cambiados en un PR revisado. Si falla, tu trabajo está a salvo.* Pulsa **Lanzar**, o **Todavía no** para volver al Intent; **Esc** equivale a **Todavía no**; un clic fuera solo pliega la línea, y la fila sigue en **Listo para convertirse en un PR** con **Lanzar**. Si el motor de tu conversación no puede pasar el Intent a un rail en este equipo, una nota justo debajo de la línea lo dice y se usa el motor por defecto del rail.

El rail, el motor, el modelo y el esfuerzo ya están elegidos (un rail libre y el motor de tu conversación). Para cambiarlos, abre **Cambiar cómo**; ahí también ves qué cambió. El coste hasta ahora aparece en la línea principal. Tus elecciones se conservan si pulsas **Todavía no** y vuelves a pasarlo más tarde. Mientras arranca, la franja lo muestra lanzándose, sin huecos, y después sigue la ejecución paso a paso. Si se alcanza el límite de revisión o un presupuesto, la línea lo dice y no se lanza nada. Si la ejecución no aparece en 45 segundos, la franja deja de girar y dice **Aún pasando a Rail 2…** con **Actualizar**, que vuelve a comprobar y sigue esperando hasta que aparezca la ejecución.

El rail deriva la spec y su cambio de spec a partir de lo que construiste, lo verifica y lo revisa, y la tarjeta de entrega aparece en la misión como en cualquier ejecución.

Si la ejecución falla por un motivo técnico, el trabajo vuelve solo a este Intent, intacto: la tarjeta dice en palabras sencillas qué falló (los códigos quedan en **Detalles técnicos**) y el agente recibe el error y lo explica. Si la revisión pide cambios, la tarjeta ofrece **Volver a Intent** o **Relanzar**. Cuando la entrega se asienta, la misión cierra el Intent con un resumen: el pull request, la spec reescrita a partir de lo que construiste, el cambio de spec archivado y la incidencia de Jira si la hay.

## Conviene saber

- Intent solo escribe en su propia rama. Fuera de Intent las misiones siguen siendo de solo lectura.
- Un Intent por misión a la vez. La pausa sobrevive a un reinicio de la app.
- Si la copia del proyecto del Intent desaparece, el Intent queda marcado como **necesita revisión** (para tu información, no hay nada que decidir) y no se borra nada.
- La franja nunca cambia la ejecución que estás mirando. Si otra empieza a necesitarte mientras tanto, su nombre en el selector de la franja dice **te necesita**.
- Jira no recibe nada mientras estás en Intent ni si lo descartas.
- El gasto de Intent aparece en Analítica como superficie propia, **Intent**, y dentro del bloque de misiones del agente.
