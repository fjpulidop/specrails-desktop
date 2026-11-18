# Si el servidor local se detiene {#server-recovery}

Specrails ejecuta en tu ordenador un pequeño servidor que mantiene en marcha tus proyectos, rails, misiones y terminales. La aplicación de escritorio lo vigila y lo recupera si se detiene.

## Qué pasa cuando el servidor se detiene

- **Specrails lo reinicia por ti.** El servidor vuelve en la misma dirección y las ventanas abiertas se reconectan solas; la barra de estado muestra **Reconectando** durante unos segundos.
- **Un aviso explica lo ocurrido**: cuándo se detuvo el servidor y por qué (un código de salida o una señal). El trabajo que estaba en marcha en ese momento puede haberse interrumpido: revisa su estado y vuelve a lanzarlo si hace falta.
- **Como mucho tres reinicios por minuto.** Si el servidor se sigue deteniendo, Specrails deja de reiniciarlo para no ocultar un problema y muestra un diálogo. Elige **Try again** para arrancarlo ahora, o cierra y vuelve a abrir Specrails. Tus proyectos guardados siguen en el disco.
- **El siguiente arranque también lo explica.** Si Specrails se cerró mientras el servidor estaba detenido, el aviso aparece la próxima vez que lo abras.

Elige **Descartar** en el aviso cuando lo hayas leído; no volverá a aparecer por esas paradas.

## Informar de un problema {#report-a-problem}

**Informar de un problema** guarda en tu ordenador un ZIP que ayuda a entender qué falló. No se sube nada: tú decides si lo compartes y con quién.

Ábrelo desde:

- **Informar de un problema** en el aviso,
- **Ajustes ▸ Acerca de ▸ Informar de un problema**,
- la paleta de comandos (**⌘K**), escribiendo *informar de un problema*.

Antes de guardar, la ventana lista cada archivo del informe y muestra su contenido. El ZIP contiene exactamente lo que ves:

| Archivo | Contenido |
| --- | --- |
| `README.txt` | Qué es el informe y qué contiene cada archivo |
| `system.json` | Versiones de la aplicación y de Core, sistema operativo, memoria |
| `settings.json` | Ajustes de la aplicación, sin tokens, claves, contraseñas, valores de entorno ni cabeceras |
| `server.log` | Salida del servidor en marcha desde que arrancó |
| `sidecar-stderr.log` | Salida de errores reciente del servidor, incluidas ejecuciones anteriores que se detuvieron (aplicación de escritorio) |
| `desktop.log` | Cuándo arrancó, se detuvo y se reinició el servidor (aplicación de escritorio) |
| `crashes.json` | Cada parada inesperada, con sus últimas líneas de error |
| `stalls.json` | Momentos en que el servidor no respondía |

Los tokens, claves de API, contraseñas, claves privadas y credenciales en URL se sustituyen por `***` o `[REDACTED]`, y tu carpeta personal aparece como `~`. Aun así, lee los archivos antes de compartirlos: puede aparecer el nombre de un proyecto o de un archivo que consideres privado.

## Capacidad de respuesta {#responsiveness}

El panel **Recursos** de la barra de estado muestra también la **Capacidad de respuesta**: cuántas veces el servidor no pudo responder durante 200 ms o más, el más largo de esos momentos y qué estaba haciendo entonces. Si hay bloqueos largos a menudo, merece la pena enviar un informe.
