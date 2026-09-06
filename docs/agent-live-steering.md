# Mensajes durante una misión

Puedes escribir más contenido mientras el agente trabaja: por ejemplo, «incluye frontend y backend» o «mantén compatible la API actual». Al enviarlo, queda en cola para el siguiente turno. Cada mensaje pendiente tiene sus propios controles:

- **Guiar:** envía esa indicación al agente durante la ejecución, sin detener el modelo. Los demás mensajes conservan su posición en la cola.
- **Borrar:** retira el mensaje pendiente para que no se ejecute.
- **⋯ → Editar:** lleva su texto al compositor conservando adjuntos y referencias.

Enviar y Detener permanecen disponibles por separado. Una vez solicitada la entrega, los controles del mensaje se desactivan para evitar modificar contenido que ya está llegando al proveedor.

Con **Claude y Codex**, las indicaciones entran por el canal nativo del proveedor durante la ejecución. No hace falta esperar a una llamada al MCP de Specrails. Claude las incorpora al contexto después de su lote de herramientas en curso; Codex acepta la actualización del turno activo mediante `turn/steer`. No se mata una herramienta para introducir el mensaje. La conversación mantiene el orden: respuesta anterior, nueva indicación y continuación del agente.

Con **Gemini y Kimi**, los transportes actuales siguen entregando las indicaciones en el siguiente punto seguro de las herramientas de Specrails. Si una acción ya está ejecutándose, se conserva su resultado. Las acciones todavía no iniciadas se suspenden para que el agente lea la corrección y revise su plan. Si no aparece otro punto de entrega, Specrails continúa con el mensaje pendiente al terminar la invocación.

Si el agente está esperando novedades de un rail o job mediante `specrails_watch`, tu mensaje termina inmediatamente esa espera para darle paso. El rail o job observado sigue ejecutándose; no se cancela como efecto de enviar el mensaje.

## Estados y recuperación

- **En cola:** el mensaje espera al siguiente turno. Puedes editarlo, borrarlo o pulsar Guiar.
- **Un check gris:** enviado desde la misión; aún falta confirmar su recepción por el proveedor. Tooltip «Enviado al agente».
- **Dos checks grises:** el transporte ha confirmado la recepción. Todavía no hay confirmación de lectura. Tooltip «Entregado al agente».
- **Dos checks verdes:** el agente ha confirmado la lectura del mensaje. Tooltip «Leído por el agente». No certifica que la implementación ya cumpla la indicación.
- **Cancelado antes de entregarse:** detuviste la misión cuando el mensaje todavía estaba pendiente de envío.
- **Entrega no confirmada:** el proceso se interrumpió o se perdió la confirmación del proveedor. El mensaje podría haber llegado; Specrails conserva el contenido y sus adjuntos y no lo reenvía automáticamente.

Una reconexión recupera los mensajes pendientes y el fragmento de respuesta actual. Si falla el envío HTTP, el borrador permanece disponible; reintentar ese mismo envío conserva su identificador para evitar duplicados cuando el servidor ya lo había aceptado.

Los estados de envío se muestran como iconos, con su explicación al pasar el ratón y una etiqueta para lectores de pantalla. Los recibos se guardan y avanzan en un solo sentido: enviado, entregado, leído. Un evento o una respuesta antigua no vuelve gris un recibo verde.

## Alcance

Enviar durante una ejecución no garantiza que el modelo cambie una acción que ya ha comenzado ni que interrumpa su razonamiento inmediatamente. El eco de usuario con UUID en Claude y la respuesta de `turn/steer` en Codex confirman recepción; por sí solos no demuestran lectura. En ambos, el verde requiere que el agente confirme esos mensajes con `specrails_mission(action:'acknowledge_inputs', inputIds:[queueId, ...])`. Una salida posterior del modelo no marca automáticamente leída una corrección nativa. En la vía MCP, confirmar la revisión entregada con `acknowledge_updates` registra la lectura. El mensaje inicial incluye un identificador de entrada y también requiere un acuse explícito de lectura. Los avisos sintéticos del proveedor no ponen checks verdes. Si el turno ya terminó antes del envío, el mensaje continúa por la vía normal. Una escritura sin confirmación nunca se reintenta automáticamente.

Claude usa un proceso `stream-json` con entrada abierta; una indicación que llega después de su última frontera interna puede ejecutarse como siguiente turno nativo del mismo proceso. Gemini ACP actualmente cancela el prompt anterior al enviar otro, y Kimi requiere un transporte Server API diferente: no se usan esas rutas como sustituto de la entrega actual.

Una indicación a la misión no cambia por sí sola un job de los rails que ya se haya lanzado. El agente debe revisar su estado y realizar las acciones de gestión apropiadas con los permisos existentes. El proveedor, el proyecto fijado y los permisos del proceso activo tampoco cambian mediante una indicación.

Las referencias a specs, archivos y repositorios conservan su identidad. Los adjuntos de texto se resuelven como contexto. Codex recibe las imágenes por su entrada nativa de archivo; Claude recibe bloques de imagen y los otros transportes usan imágenes MCP, con un presupuesto de 8 MiB por lote. Los archivos originales y sus referencias se conservan; las imágenes no disponibles o que superan el presupuesto se indican explícitamente sin inventar su contenido.

## Implementación

`agent_inputs` es una tabla aditiva en la base de datos global. Cada mensaje tiene un identificador idempotente por conversación, metadatos y estado. La entrega y la creación de la fila del usuario son atómicas. Los mensajes cancelados o interrumpidos no se incorporan como nuevas instrucciones al reconstruir el historial del proveedor.

Cada invocación tiene un único canal de entrega. Los transportes nativos conservan los permisos, el directorio y la configuración MCP del proceso. La confirmación del proveedor guarda de forma síncrona el fragmento de conversación antes de publicar más salida. La admisión, los límites de procesos y el encaminamiento de Headroom siguen usando `spawnAiCli`.

Para los transportes con entrega MCP, el intermediario se vincula al objeto de base de datos y a la capability de una invocación concreta. Intercepta las herramientas antes y después del despacho. El agente confirma las revisiones con `specrails_mission(acknowledge_updates)`; confirmar una entrega anterior no desbloquea acciones mientras haya indicaciones posteriores pendientes. Las llamadas externas o de otra misión no acceden a esta bandeja.

La migración 28 añade el recibo a la tabla existente. Las entregas anteriores se convierten en recibidas, nunca en leídas por suposición. `agent_input_receipt` actualiza el icono sin alterar el orden de la conversación ni la respuesta en curso. La confirmación de lectura nativa valida el lote completo contra los mensajes entregados en esa invocación; no puede marcar mensajes pendientes, de otra misión o de una invocación anterior.

Cada invocación, incluido un reintento por sesión caducada, recibe una capability y un archivo de credenciales propios. Al finalizar, ambos quedan revocados o retirados. Una llamada tardía de un proceso anterior no puede consumir mensajes ni heredar los permisos de la siguiente invocación.

## Fuentes de los protocolos

- [Claude CLI: stream-json y replay-user-messages](https://code.claude.com/docs/en/cli-reference), contrastado con el bucle nativo de Claude Code 2.1.261.
- [Codex app-server](https://learn.chatgpt.com/docs/app-server), contrastado con el esquema generado por Codex 0.153.4.
- [Gemini model steering](https://geminicli.com/docs/cli/model-steering/) y ACP instalado 0.49.0: la capacidad interactiva no equivale a entrada sin interrupción en su transporte ACP.
- [Kimi Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html): transporte distinto del modo print utilizado actualmente.
