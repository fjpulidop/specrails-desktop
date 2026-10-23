# Flow: construir primero, spec después

Flow es una forma de construir con un agente cuando todavía no sabes exactamente qué quieres. Hablas con el agente en tu misión, escribe y ejecuta código real en su propia rama de Flow (una copia aparte de tu proyecto) y, cuando el resultado es el bueno, pulsas **Pasar a un rail**: un rail toma tus cambios, deriva la spec y ejecuta la verificación, la revisión y la entrega de siempre.

Implement sirve para delegar trabajo que ya sabes describir. Flow, para descubrirlo.

## Cómo empieza un Flow

No tienes que pedir Flow por su nombre. Cuando describes algo exploratorio o visual («quiero probar…», «no sé cómo debería quedar»), la misión muestra una tarjeta con dos caminos:

- **Flow**: construirlo juntos ahora; la spec llega al final.
- **Spec + Implement**: acordar primero una spec y luego delegarla a un rail.

Los dos caminos tienen el mismo peso y aparecen siempre en el mismo orden: ninguno se recomienda, eliges tú. En **Por qué pregunta el agente**, el agente explica en una frase qué le hizo preguntar, y no insistirá elijas el camino que elijas o si pulsas **Ahora no**.

Al elegir Flow se abre una confirmación: Specrails crea una copia aparte del proyecto en su propia rama de Flow, donde el agente puede escribir código, y tu rama principal no se toca. Pulsa **Empezar Flow**. En el board aparece una spec provisional con la etiqueta **En Flow** (haz clic en ella para volver a la misión).

Si tu Specrails Core todavía no puede ejecutar Flow, el botón está desactivado y la tarjeta lista lo que falta. Normalmente se arregla actualizando Specrails Core.

## Mientras estás en Flow

El modo Flow se nombra allí donde miras, con su propio color de Flow: el compositor muestra un chip **Flow** junto al de autonomía y la pista *Dile al agente qué cambiar en este Flow…*; el título de la misión indica **En Flow**, igual que su fila en la lista de misiones. La conversación marca dónde entraste y saliste de Flow, y las respuestas del agente escritas en Flow llevan una pequeña marca **Flow** junto a su hora.

La franja justo encima del compositor muestra el Flow en una fila corta: su estado, **Flow · 7 archivos**, **Pausar** y la acción principal, **Pasar a un rail**. Cuando una acción no está disponible (el Flow aún está guardando, hay otra acción en curso), al pasar el ratón dice por qué. Abre la fila con su flecha, como cualquier otra ejecución, para ver el resto:

- la **rama** (pulsa para copiar su nombre), los **cambios** con líneas añadidas y eliminadas (pulsa para ver cada archivo con su estado y +/−) y el **coste hasta ahora** según factura el proveedor. Muestra `—` hasta que un turno tiene coste informado, y nunca una estimación; un `*` marca un total que deja fuera turnos sin precio, con una nota que dice cuántos;
- **Vista previa** mientras la app del Flow está en marcha (ver más abajo);
- **Descartar**, aparte, borra los cambios del Flow, su rama y la spec provisional. La confirmación enumera lo que pierdes: los archivos cambiados con sus +/−, la rama y la spec.

**Pausar** detiene al agente y conserva tus cambios y la spec. La fila muestra entonces **Reanudar Flow**.

Puedes escribir mientras el agente trabaja: en Flow tu mensaje **interrumpe** el paso actual (el botón de enviar se convierte en un rayo) y el agente sigue al momento con tu nueva información. Mientras el Flow está abierto, la franja de git bajo el compositor se aparta: el panel del Flow ya muestra su rama.

## Prueba la app

El agente de Flow ejecuta él mismo el typecheck y los tests para comprobar su trabajo. Cuando hay algo que probar, te pregunta con tres opciones: **Start the app**, **Start and expose on the local network** o **Not now**. Exponerla te permite abrir la app desde un móvil en la misma Wi-Fi o VPN, y cualquiera en esa red puede acceder a ella.

Cuando la app escucha, el agente te da sus direcciones como enlaces y el panel del Flow muestra **Vista previa** con un punto verde: abre la app en tu navegador. Su menú tiene la dirección de red y **Detener app**. La app se ejecuta desde la copia del Flow, nunca desde tu checkout principal, y Specrails la detiene cuando pausas, descartas o entregas el Flow.

## Pasar a un rail

Cuando el resultado te convenza, pulsa **Pasar a un rail**. La fila pasa a **Listo para convertirse en un PR** y abre una sola línea encima: *Rail 2 convertirá tus 7 archivos cambiados en un PR revisado. Si falla, tu trabajo está a salvo.* Pulsa **Lanzar**, o **Todavía no** para volver al Flow.

El rail, el motor, el modelo y el esfuerzo ya están elegidos (un rail libre y el motor de tu conversación). Para cambiarlos, abre **Cambiar cómo**; ahí también ves qué cambió y el coste hasta ahora. Mientras arranca, la franja lo muestra lanzándose, sin huecos, y después sigue la ejecución paso a paso. Si se alcanza el límite de revisión o un presupuesto, la línea lo dice y no se lanza nada. El **Lanzar** de la propia franja nunca lanza por sí solo: vuelve a mostrar la línea con el foco en Lanzar, así que siempre confirmas allí.

El rail deriva la spec y su cambio de spec a partir de lo que construiste, lo verifica y lo revisa, y la tarjeta de entrega aparece en la misión como en cualquier ejecución.

Si la ejecución falla por un motivo técnico, el trabajo vuelve solo a este Flow, intacto: la tarjeta dice en palabras sencillas qué falló (los códigos quedan en **Detalles técnicos**) y el agente recibe el error y lo explica. Si la revisión pide cambios, la tarjeta ofrece **Volver a Flow** o **Relanzar**. Cuando la entrega se asienta, la misión cierra el Flow con un resumen: el pull request, la spec reescrita a partir de lo que construiste, el cambio de spec archivado y la incidencia de Jira si la hay.

## Conviene saber

- Flow solo escribe en su propia rama. Fuera de Flow las misiones siguen siendo de solo lectura.
- Un Flow por misión a la vez. La pausa sobrevive a un reinicio de la app.
- Si la copia del proyecto del Flow desaparece, el Flow queda marcado como **necesita revisión** (para tu información, no hay nada que decidir) y no se borra nada.
- La franja nunca cambia la ejecución que estás mirando. Si otra empieza a necesitarte mientras tanto, su nombre en el selector de la franja dice **te necesita**.
- Jira no recibe nada mientras estás en Flow ni si lo descartas.
- El gasto de Flow aparece en Analítica como superficie propia, **Flow**, y dentro del bloque de misiones del agente.
