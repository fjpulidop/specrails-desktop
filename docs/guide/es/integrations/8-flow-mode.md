# Flow: construir primero, spec después

Flow es una forma de construir con un agente cuando todavía no sabes exactamente qué quieres. Hablas con el agente en tu misión, escribe y ejecuta código real en un worktree aislado y, cuando el resultado es el bueno, dices **Esto es**: un rail toma el worktree, deriva la spec y ejecuta la verificación, la revisión y la entrega de siempre.

Implement sirve para delegar trabajo que ya sabes describir. Flow, para descubrirlo.

## Cómo empieza un Flow

No tienes que pedir Flow por su nombre. Cuando describes algo exploratorio o visual («quiero probar…», «no sé cómo debería quedar»), la misión muestra una tarjeta con dos caminos:

- **Flow**: construirlo juntos ahora; la spec llega al final.
- **Spec + Implement**: acordar primero una spec y luego delegarla a un rail.

Los dos caminos tienen el mismo peso y aparecen siempre en el mismo orden: ninguno se recomienda, eliges tú. En **Por qué pregunta el agente**, el agente explica en una frase qué le hizo preguntar, y no insistirá elijas el camino que elijas o si pulsas **Ahora no**.

Al elegir Flow se abre una confirmación: Specrails crea un worktree aislado donde el agente puede escribir código, y tu rama principal no se toca. Pulsa **Empezar Flow**. En el board aparece una spec provisional con la etiqueta **En Flow** (haz clic en ella para volver a la misión).

Si tu Specrails Core todavía no puede ejecutar Flow, el botón está desactivado y la tarjeta lista lo que falta; normalmente se arregla actualizando Specrails Core.

## Mientras estás en Flow

La conversación cambia de aspecto (una fina línea de acento en el borde) y aparece una barra encima del compositor:

- la **rama** del worktree, los **ficheros cambiados** con líneas añadidas y eliminadas, y el **gasto real** del Flow hasta ahora según factura el proveedor. Muestra `—` hasta que un turno tiene coste informado, y nunca una estimación;
- **Ver cambios** lista cada fichero cambiado con su estado y +/−;
- **Pausar** detiene al agente y conserva el worktree y la spec. La misión muestra entonces **Reanudar Flow**;
- **Descartar** borra el worktree, su rama y la spec provisional, tras una confirmación;
- **Esto es**: la acción principal, más abajo.

Puedes escribir mientras el agente trabaja: en Flow tu mensaje **interrumpe** el paso actual (el botón de enviar se convierte en un rayo) y el agente sigue al momento con tu nueva información. La franja de git bajo el compositor muestra la rama del worktree.

## Prueba la app

El agente de Flow ejecuta él mismo el typecheck y los tests para comprobar su trabajo. Cuando hay algo que probar, te pregunta con tres opciones: **Start the app**, **Start and expose on the local network** o **Not now**. Exponerla te permite abrir la app desde un móvil en la misma Wi-Fi o VPN, y cualquiera en esa red puede acceder a ella.

Cuando la app escucha, el agente te da sus direcciones como enlaces y la barra de Flow muestra **Vista previa** con un punto verde: abre la app en tu navegador. Su menú tiene la dirección de red y **Detener app**. La app se ejecuta en el worktree del Flow, nunca en tu checkout principal, y Specrails la detiene cuando pausas, descartas o entregas el Flow.

## Esto es

Cuando el resultado te convenza, pulsa **Esto es**. La barra de Flow y el tratamiento visual desaparecen y aparece la tarjeta de lanzamiento de rail de siempre, con el loop **Flow → Spec** preseleccionado y un rail libre elegido por ti. Ajusta el motor, el modelo o el esfuerzo si quieres y pulsa **Lanzar**. Si se ha alcanzado el límite de revisión o un presupuesto, la tarjeta lo dice y no lanza. **Todavía no** te devuelve al Flow.

El rail deriva la spec de Specrails y el cambio OpenSpec a partir de lo que construiste, lo verifica y lo revisa, y la tarjeta de entrega aparece en la misión como en cualquier ejecución.

## Conviene saber

- Flow solo escribe dentro de su worktree. Fuera de Flow las misiones siguen siendo de solo lectura.
- Un Flow por misión a la vez. La pausa sobrevive a un reinicio de la app.
- Si el worktree desaparece, el Flow queda marcado como **necesita revisión** y no se borra nada.
- Jira no recibe nada mientras estás en Flow ni si lo descartas.
- El gasto de Flow aparece en Analítica como superficie propia, **Flow**, y dentro del bloque de misiones del agente.
