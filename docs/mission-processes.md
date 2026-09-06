# Aplicaciones y procesos de las misiones

El agente arranca aplicaciones, servidores de desarrollo y watchers mediante `specrails_jobs(background_start)`. El proceso queda ligado a la misión, al proyecto y al repositorio elegido, y aparece como una pastilla sobre el compositor. En proyectos con varios repositorios, el agente indica `repositoryId` para arrancar cada aplicación en la carpeta correcta.

El comando debe mantener el servidor en primer plano, por ejemplo `npm run dev`. No necesita `nohup` ni un `&` final: Specrails ya se encarga de ejecutarlo en segundo plano y conservar su control.

Antes de lanzar otra copia, el agente consulta `background_list`. El arranque devuelve `pid` y `processId`: este último identifica la ejecución aunque el sistema operativo reutilice el PID más adelante. Aceptar un comando no demuestra que la aplicación esté lista; consultar sus logs para identificar la URL o un error de arranque forma parte de la petición de lanzamiento y no necesita otra confirmación para leerlos.

## Detener una aplicación

La X de la pastilla solicita la parada directamente. Mientras se confirma, aparece «Deteniendo» y el proceso sigue visible. Specrails intenta cerrar el grupo o árbol de procesos, da un plazo a la terminación normal y fuerza la parada si la aplicación no responde. La salida del shell por sí sola no cuenta como aplicación detenida.

Si la petición o la parada falla, la interfaz muestra el error y permite reintentar. Las peticiones repetidas conservan la identidad de la ejecución y no se dirigen a otro proceso que tenga el mismo PID. La interfaz vuelve a consultar el estado durante la parada, al recuperar la conexión y al regresar a la ventana.

Al cerrar un proyecto o Specrails se aplica el mismo cierre de procesos. El servidor espera un plazo limitado para que termine la limpieza antes de salir; la aplicación de escritorio deja margen para esa espera.

## Explorar los logs

Al pulsar el cuerpo de la pastilla se abre el inspector. La X de parada y el botón que abre el inspector son controles separados, también accesibles con el teclado.

El botón **Procesos** del compositor abre el historial de la misión, aunque las pastillas de ejecuciones terminadas ya hayan desaparecido. Permite buscar por comando, carpeta, repositorio, PID o estado. Seleccionar una ejecución abre sus logs; volver al historial conserva la búsqueda. La reconexión y la recarga recuperan este historial del servidor.

El modal muestra comando, carpeta, repositorio, estado, duración y resultado de salida. Incluye:

- Salida estándar y errores, incluso si el proceso todavía no ha escrito un salto de línea.
- Búsqueda de texto y filtro por `stdout` o `stderr`.
- Pausa de la actualización y seguimiento de las últimas líneas. Desplazarse hacia arriba desactiva el seguimiento para poder leer.
- Copia y descarga de la vista filtrada.
- Avisos de errores de lectura y de truncamiento, con reintento.

Los logs se consultan únicamente mientras el inspector está abierto y actualizándose. Las secuencias de terminal se convierten en texto; no se ejecuta HTML ni se abren enlaces de control incluidos en la salida. Un inspector abierto conserva su última captura aunque desaparezca la pastilla del proceso terminado.

## Retención y alcance

El servidor guarda el historial en `~/.specrails/background-processes.sqlite`, junto al catálogo de proyectos, usando una base separada para el tráfico de logs. Conserva hasta 10.000 líneas de 4.000 caracteres por ejecución, durante 30 días, con un máximo de 1.000 ejecuciones terminadas y 256 MiB de texto retenido en total. Cuando se alcanzan los límites, elimina primero el historial más antiguo. SQLite reutiliza las páginas liberadas; el tamaño del archivo puede superar el texto retenido por sus índices y metadatos.

La captura en memoria mantiene las últimas 2.000 líneas y hasta 32 ejecuciones terminadas durante diez minutos, pero su caducidad no borra el historial persistente. El inspector limita la vista a 2.000 líneas y 512 KiB de texto para mantenerla ágil; indica cualquier truncamiento. La búsqueda dentro del log y su exportación abarcan la vista disponible. MCP devuelve una cola más pequeña para no saturar el contexto del agente, y permite paginar los metadatos del historial con `limit` y `offset`.

Los cambios de estado se guardan en sus transiciones y la salida se escribe en lotes cada 250 ms. El cierre normal de un proceso y de Specrails vacía los lotes pendientes. Un cierre brusco puede perder la última fracción de segundo aún sin escribir; un fallo de almacenamiento se muestra como aviso independiente y permite seguir deteniendo los procesos. Borrar una misión o un proyecto elimina también su historial. Una segunda instancia no puede apropiarse del historial de un servidor de Specrails que siga activo.

Después de reiniciar, las ejecuciones que no habían confirmado su final aparecen como **Desconectadas**. Esto significa que Specrails perdió su supervisión: no demuestra que su proceso del sistema esté detenido. Sus logs siguen siendo consultables, pero la aplicación no intenta señalizar un PID antiguo. Las lecturas y paradas mantienen el aislamiento por misión, proyecto e identidad de ejecución.

Los logs que una versión anterior ya descartó al guardarlos sólo en memoria no pueden recuperarse retrospectivamente.

El cierre controla los grupos o árboles que Specrails ha creado. Aplicaciones que se desasocien deliberadamente y creen un servicio externo requieren la gestión propia de ese servicio. Esta función no sustituye a un supervisor del sistema operativo ni detiene procesos ajenos por coincidir en un puerto.

## Implementación y referencia

`transient-children.ts` mantiene el ciclo de vida y los lotes; `background-process-store.ts` guarda el historial y `background-process-control.ts` encapsula el control del sistema operativo. REST y MCP comparten `background-process-service.ts`. El contexto del cliente reconcilia las ejecuciones y los modales de historial y logs presentan las capturas.

## Puertos de las aplicaciones y conexión de la misión

Specrails escucha su API en `127.0.0.1:4200` por defecto. Otro servidor puede ocupar `[::1]:4200` simultáneamente: comparten el número de puerto, pero pertenecen a familias de direcciones diferentes. Por eso el proxy de desarrollo, la autenticación y el WebSocket usan IPv4 explícito para llegar a Specrails y evitar que un `localhost` ambiguo devuelva el HTML de un proyecto.

`SPECRAILS_DEV_SERVER_PORT` configura la API de desarrollo, con `SPECRAILS_PORT` como alternativa. `SPECRAILS_DEV_CLIENT_PORT` configura el cliente; ambos deben ser distintos. Vite informa de un puerto ocupado en lugar de cambiarlo silenciosamente. Conviene usar puertos de aplicación distintos de los reservados por Specrails, que el agente puede consultar mediante `background_list`.

Si una petición de misión recibe HTML, una respuesta inválida o ninguna confirmación de admisión, muestra un error traducido y conserva el borrador con sus referencias, adjuntos e identidad de envío. No reenvía automáticamente una operación cuyo resultado pueda ser incierto.

La separación entre shell, descendientes y eventos de salida se basa en los contratos de [procesos hijos de Node.js](https://nodejs.org/api/child_process.html#optionsdetached) y [señales de proceso](https://nodejs.org/api/process.html#processkillpid-signal), y se verifica con procesos locales desechables.
