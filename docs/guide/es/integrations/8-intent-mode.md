# Intent: construir primero, spec después {#intent-mode}

Intent es una forma de construir con un agente cuando todavía no sabes exactamente qué quieres. Hablas con el agente en tu misión, escribe y ejecuta código real en su propia rama de Intent (una copia aparte de tu proyecto) y, cuando el resultado es el bueno, pulsas **Pasar a un rail**: un rail toma tus cambios, deriva la spec y ejecuta la verificación, la revisión y la entrega de siempre.

Implement sirve para delegar trabajo que ya sabes describir. Intent, para descubrirlo.

## Cómo empieza un Intent

No tienes que pedir Intent por su nombre. Cuando describes algo exploratorio o visual («quiero probar…», «no sé cómo debería quedar»), la misión muestra una tarjeta con dos caminos:

- **Intent**: construirlo juntos ahora; la spec llega al final.
- **Spec + Implement**: acordar primero una spec y luego delegarla a un rail.

Los dos caminos tienen el mismo peso y aparecen siempre en el mismo orden: ninguno se recomienda, eliges tú. En **Por qué pregunta el agente**, el agente explica en una frase qué le hizo preguntar, y no insistirá elijas el camino que elijas o si pulsas **Ahora no**.

Al elegir Intent se abre una confirmación: Specrails crea una copia aparte del proyecto en su propia rama de Intent, donde el agente puede escribir código, y tu rama principal no se toca. Pulsa **Empezar Intent**. En el board aparece una spec provisional con la etiqueta **En Intent** (haz clic en ella para volver a la misión).

Si tu Specrails Core todavía no puede ejecutar Intent, el botón está desactivado y la tarjeta lista lo que falta. Normalmente se arregla actualizando Specrails Core.

## Empezar un Intent desde una spec que ya tienes

Cualquier spec se puede construir en Intent, no solo una idea nueva. Intent e Implement siguen siendo dos formas iguales de trabajarla:

- en el tablero, haz clic derecho en una spec y elige **Empezar en Intent** (junto a arrastrarla a un rail); en el detalle de la spec, **Empezar en Intent** está junto a **Mover a rail**;
- en una misión, cuando pides implementar una spec sin nombrar un rail, el agente muestra la misma tarjeta de dos caminos para esa spec: **Intent** la trabaja contigo y **Spec + Implement** la lanza en un rail;
- una tarjeta de lanzamiento en rail de una sola spec también ofrece **Empezar en Intent** junto a su lanzamiento.

La propia spec pasa a **En Intent**: no se crea ninguna spec provisional y el primer turno del agente recibe la spec (sus criterios de aceptación, la Contract Layer, lo que queda fuera de alcance y los addenda abiertos). Si la empiezas desde el tablero, el Intent se abre en la misión de la propia spec o en una misión nueva con el nombre de la spec. En un proyecto con varios repositorios Git, cuando la spec no indica exactamente uno de ellos, un pequeño diálogo pregunta antes dónde se ejecuta el Intent: solo aparecen los repositorios Git, viene preseleccionado el repositorio de la spec (o, si no, el principal) y las flechas cambian la elección. **Empezar en Intent** aparece desactivado, con el motivo al pasar el ratón, cuando la spec ya está en Intent, está hecha o cancelada, está en un rail o Intent no está disponible.

**Descartar** devuelve la spec tal como estaba, con su estado anterior: tu spec nunca se borra. Cuando el Intent se entrega, la spec se reescribe a partir de lo construido y antes se guarda su texto original como comentario, **Original spec before Intent**, para que no se pierda nada. Una spec ya enlazada con Jira actualiza esa misma incidencia y la mueve al estado asignado a revisión; no se crea una segunda.

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
