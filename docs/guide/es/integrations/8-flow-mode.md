# Flow: construir primero, spec después

Flow es una forma de construir con un agente cuando todavía no sabes exactamente qué quieres. Hablas con el agente en tu misión, escribe y ejecuta código real en un worktree aislado y, cuando el resultado es el bueno, dices **Ya está**: un rail toma el worktree, deriva la spec y ejecuta la verificación, la revisión y la entrega de siempre.

Implement sirve para delegar trabajo que ya sabes describir. Flow, para descubrirlo.

## Cómo empieza un Flow

No tienes que pedir Flow por su nombre. Cuando describes algo exploratorio o visual («quiero probar…», «no sé cómo debería quedar»), la misión muestra una tarjeta con dos caminos:

- **Flow**: construirlo juntos ahora; la spec llega al final.
- **Spec + Implement**: acordar primero una spec y luego delegarla a un rail.

Los dos caminos tienen el mismo peso y aparecen siempre en el mismo orden: ninguno se recomienda, eliges tú. En **Por qué pregunta el agente**, el agente explica en una frase qué le hizo preguntar, y no insistirá elijas el camino que elijas o si pulsas **Ahora no**.

Al elegir Flow se abre una confirmación: Specrails crea un worktree aislado donde el agente puede escribir código, y tu rama principal no se toca. Pulsa **Empezar Flow**. En el board aparece una spec provisional con la etiqueta **En Flow** (haz clic en ella para volver a la misión).

Si tu Specrails Core todavía no puede ejecutar Flow, el botón está desactivado y la tarjeta lista lo que falta; normalmente se arregla actualizando Specrails Core.

## Mientras estás en Flow

El modo Flow se nombra allí donde miras: el compositor muestra un chip **Flow** junto al de autonomía, una fina línea de acento en su borde superior y la pista *Dile al agente qué cambiar en el worktree…*; el título de la misión indica **En Flow**, igual que su fila en la lista de misiones. La conversación marca dónde entraste y saliste de Flow, y las respuestas del agente escritas en Flow llevan una pequeña marca **Flow** junto a su hora. La barra justo encima del compositor muestra el Flow:

- la **rama** del worktree, los **ficheros cambiados** con líneas añadidas y eliminadas, y el **gasto real** del Flow hasta ahora según factura el proveedor. Muestra `—` hasta que un turno tiene coste informado, y nunca una estimación;
- pulsa los **ficheros cambiados** para ver cada fichero con su estado y +/−, y la **rama** para copiar su nombre;
- **Pausar** detiene al agente y conserva el worktree y la spec. La misión muestra entonces **Reanudar Flow**;
- **Descartar**, separado a la izquierda, borra el worktree, su rama y la spec provisional. La confirmación enumera lo que pierdes: los ficheros cambiados con sus +/−, la rama y la spec;
- **Ya está**: la acción principal, más abajo. Cuando no está disponible (el Flow aún está guardando, hay otra acción en curso), al pasar el ratón dice por qué.

Puedes escribir mientras el agente trabaja: en Flow tu mensaje **interrumpe** el paso actual (el botón de enviar se convierte en un rayo) y el agente sigue al momento con tu nueva información. Mientras la barra está visible, la franja de git bajo el compositor se aparta: la barra ya muestra la rama del worktree.

## Prueba la app

El agente de Flow ejecuta él mismo el typecheck y los tests para comprobar su trabajo. Cuando hay algo que probar, te pregunta con tres opciones: **Start the app**, **Start and expose on the local network** o **Not now**. Exponerla te permite abrir la app desde un móvil en la misma Wi-Fi o VPN, y cualquiera en esa red puede acceder a ella.

Cuando la app escucha, el agente te da sus direcciones como enlaces y la barra de Flow muestra **Vista previa** con un punto verde: abre la app en tu navegador. Su menú tiene la dirección de red y **Detener app**. La app se ejecuta en el worktree del Flow, nunca en tu checkout principal, y Specrails la detiene cuando pausas, descartas o entregas el Flow.

## Ya está

Cuando el resultado te convenza, pulsa **Ya está**. La misma barra pasa a **Flow → Spec listo para lanzar** y abre sus ajustes justo encima: el loop **Flow → Spec**, un rail libre elegido por ti y el motor, modelo y esfuerzo de tu conversación. Ajusta lo que quieras y pulsa **Lanzar** (en el panel o en la barra). Mientras arranca, la barra lo muestra lanzándose — sin huecos — y después sigue la ejecución paso a paso. Si se alcanza el límite de revisión o un presupuesto, el panel lo dice y no lanza. **Todavía no** te devuelve al Flow.

El rail deriva la spec de Specrails y el cambio OpenSpec a partir de lo que construiste, lo verifica y lo revisa, y la tarjeta de entrega aparece en la misión como en cualquier ejecución.

En ese panel, un resumen de una línea muestra lo que va al rail (ficheros y líneas) y el coste del Flow hasta ahora. Si la ejecución falla por un motivo técnico, el trabajo vuelve solo a este Flow, intacto: la tarjeta dice en palabras sencillas qué falló (los códigos quedan en **Detalles técnicos**) y el agente recibe el error y lo explica. Si la revisión pide cambios, la tarjeta ofrece **Volver a Flow** o **Relanzar**. Cuando la entrega se asienta, la misión cierra el Flow con un resumen: el pull request, la spec reescrita a partir de lo que construiste, el cambio de OpenSpec archivado y la incidencia de Jira si la hay.

## Conviene saber

- Flow solo escribe dentro de su worktree. Fuera de Flow las misiones siguen siendo de solo lectura.
- Un Flow por misión a la vez. La pausa sobrevive a un reinicio de la app.
- Si el worktree desaparece, el Flow queda marcado como **necesita revisión** y no se borra nada.
- Jira no recibe nada mientras estás en Flow ni si lo descartas.
- El gasto de Flow aparece en Analítica como superficie propia, **Flow**, y dentro del bloque de misiones del agente.
