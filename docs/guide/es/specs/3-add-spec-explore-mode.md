# Añadir spec — Modo Explore

El modo Explore es una conversación. En lugar de escribir tú mismo la spec, hablas sobre la idea con la IA: actúa como compañero de reflexión, hace preguntas, propone estructura y construye un **borrador en vivo** de la spec sobre la marcha. Cuando estés a gusto, confirmas el borrador como una spec real.

Recurre a Explore cuando la idea todavía no está del todo formada, cuando hay compromisos que conviene hablar o cuando quieres que la IA mire tu código real antes de fijar la spec.

## Crear una spec en modo Explore

Para dar forma a una spec en modo Explore:

1. En el Dashboard, haz clic en **Añadir** y luego elige **Explore**.
2. Escribe tu primer mensaje: la idea, una pregunta o un pensamiento a medio formar.
3. Lee la respuesta de la IA y sigue contestando. En cada turno, refina su comprensión.
4. Observa cómo se actualiza el **borrador en vivo** junto al chat: esta es la spec tomando forma.
5. Cuando el borrador tenga buena pinta, haz clic en **Crear spec**.

La conversación queda en tu historial, así que siempre puedes volver para ver cómo se le dio forma a la spec.

## El borrador en vivo

A medida que conversas, un panel de borrador muestra la spec tal como está en cada momento: título, descripción, prioridad, etiquetas y criterios de aceptación. Se reescribe en cada turno en función de lo que habéis comentado. No lo editas directamente; lo guías a través de la conversación («en realidad, pon la prioridad en alta», «añade un criterio sobre el manejo de errores», y así).

Esto es el corazón del modo Explore: nunca estás mirando un formulario en blanco. Siempre tienes delante una spec real y en evolución.

## Cuánto ve la IA: el control deslizante de contexto

Antes de que la IA responda, decides cuánto de tu proyecto puede ver. Un control deslizante de presets de contexto te permite cambiar velocidad por profundidad:

| Preset | Qué ve la IA |
|--------|--------------|
| **Mínimo** | Solo tu mensaje. Lo más rápido y barato. |
| **Ligero** | + tus specs existentes. |
| **Estándar** | + tus specs y las specs de OpenSpec de tu proyecto. |
| **Amplio** | + acceso de lectura a todo tu código, para que pueda fundamentar las respuestas en código real. |
| **Max** | Amplio, más una pasada de enriquecimiento con Contract Layer al confirmar. |
| **Desktop** | Max, más los servidores MCP de tu proyecto y tus propios servidores MCP aprobados. |

Empieza bajo para una lluvia de ideas rápida; sube cuando quieras que la IA verifique sus sugerencias contra tu código real. La elección se guarda en la conversación, así que no se filtra a otras sesiones de Explore.

Si quieres un control más fino, haz clic en **Ajuste fino** para activar las opciones subyacentes a mano, incluida **Mis MCP aprobados**, que carga los servidores MCP que ya has aprobado en local sin ralentizar la sesión.

## Botones del shell de Explore

- **Crear spec**: promueve el borrador en vivo a una spec real con estado **Por hacer**. (Cuando estás editando una spec existente, este botón pasa a leer **Actualizar spec** y parchea esa spec en su sitio.)
- **Revisar →**: abre una superposición de revisión que muestra la spec propuesta comparada con la línea base antes de confirmar, para que no haya sorpresas.
- **Guardar como borrador**: conserva la conversación como un ticket de borrador para que puedas retomarlo más tarde. Disponible en cuanto hayas enviado al menos un mensaje. Ver más abajo.
- **Minimizar**: aparca la conversación como un chip en el dock de chats minimizados, abajo a la izquierda. Haz clic en el chip en cualquier momento para volver directamente a la conversación: no se pierde nada.
- **Descartar**: tira la conversación a la basura (pide confirmación primero).

## Guardar como borrador

¿No estás listo para confirmar, pero no quieres perder lo pensado? Haz clic en **Guardar como borrador**. La conversación se convierte en una **spec en borrador** en tu tablero, y el borrador queda vinculado a la conversación que hay detrás.

Más tarde, abre el borrador desde el tablero y haz clic en **Seguir editando**: la conversación original se reabre con su historial de chat intacto y continúas exactamente donde lo dejaste. Los borradores nunca se borran automáticamente; te esperan.

Esto hace que Explore sea seguro para ideas a medio cocer: empieza una conversación, llega a algún sitio, guárdala como borrador y vuelve mañana.

Para todo lo relacionado con los borradores —incluido el enriquecimiento con Contract Layer— consulta [Borradores y la Contract Layer](drafts-and-contract-layer.md).

## Nota sobre múltiples proveedores

Si tu proyecto tiene instalado más de un proveedor de IA, un selector de motor te permite elegir cuál impulsa la conversación de Explore. Los proyectos con un solo proveedor no lo muestran.

## Adónde ir después

- [Borradores y la Contract Layer](drafts-and-contract-layer.md): guardar el trabajo en curso y enriquecer las specs para el pipeline.
- [Añadir spec — Modo Quick](add-spec-quick-mode.md): cuando la idea ya está clara.
- [Ejecutar pipelines](running-pipelines.md): implementa tu spec una vez esté lista.
