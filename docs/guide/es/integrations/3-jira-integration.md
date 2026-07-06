# Integración con Jira

¿Quieres que tus specs vivan en un **tablero de Jira** real en lugar de dentro de Specrails? La integración con Jira respalda las specs de un proyecto con issues de Jira, mantiene los estados sincronizados a medida que se ejecutan los rails y no estorba el resto del tiempo. Cada proyecto se sincroniza con **su propio** tablero de Jira.

## Cómo funciona (la versión corta)

Specrails actúa como **capa de sincronización** entre Jira y tu proyecto. La idea central: tu almacén local de specs sigue siendo lo canónico que lee el pipeline, y Specrails se encarga de mantenerlo de acuerdo con Jira.

- Cuando lanzas un rail, Specrails mueve el issue de Jira vinculado a **En progreso**.
- Cuando un trabajo termina, Specrails transiciona el issue: si tuvo éxito, lo mueve a tu estado de **revisión** mapeado y solo llega a **Hecho** cuando se mergea la PR de entrega o aceptas el resultado local; si falló, vuelve a **Por hacer** con un comentario de finalización que incluye resultado, id de ejecución, coste, duración y el cambio de estado en Jira.
- Si pides cambios de seguimiento cuando el issue de Jira ya está en revisión, Specrails intenta continuar la rama de la PR abierta existente para ese ticket en lugar de crear una rama nueva. Si tu estado de revisión de Jira no está mapeado explícitamente y todavía aparece localmente como **En progreso**, Specrails puede continuar igualmente la PR cuando la clave de Jira coincide con la pull request abierta.
- Periódicamente, Specrails **sondea** Jira en busca de cambios que cualquiera haya hecho en el tablero y los refleja de vuelta en tus specs.

Todas las escrituras pasan por un outbox duradero y a prueba de fallos, así que un tropiezo puntual de Jira nunca rompe un trabajo: la actualización simplemente se reintenta.

## Conectar un tablero

Te conectas desde la página de **Ajustes** de un proyecto (también hay un paso opcional «Configurar Jira» al final del asistente de Añadir proyecto). El asistente de conexión te guía paso a paso:

1. **Probar** — introduce la URL de tu Jira y tus credenciales, y Specrails verifica la conexión.
2. **Elegir un proyecto** — elige con qué proyecto de Jira sincronizar.
3. **Mapa de estados (opcional)** — asigna los estados de tu flujo de Jira a los estados de Specrails si la detección automática necesita una ayuda (más abajo).
4. **Conectar** — listo. Tus specs ahora reflejan ese tablero.

### Autenticación

Esta versión usa autenticación por **pegado de token**: rápida, en el dispositivo y sin ningún backend de por medio:

- **Jira Cloud:** el email de tu cuenta más un token de API.
- **Jira Data Center / Server:** un Personal Access Token (PAT).

Tu token se guarda **cifrado en tu propia máquina** y nunca sale de ella. La app solo muestra si hay un token presente, nunca el token en sí.

## Mapeo de estados

La parte más delicada de cualquier sincronización con Jira es hacer coincidir *tu* flujo de trabajo con los estados sencillos de Specrails (Por hacer / En progreso / En revisión / Hecho, más las variantes de cancelar). Specrails lo resuelve en dos niveles:

1. **Tu mapa de estados explícito**, si configuras uno en el asistente: siempre gana.
2. **Detección automática** a partir de la categoría de cada estado (nuevo / en progreso / hecho) más una coincidencia inteligente para los estados de tipo cancelar y entregar.

Cuando necesita mover un issue a través de un flujo con transiciones condicionadas, encuentra un camino válido paso a paso y rellena por el camino cualquier campo obligatorio (como una resolución). Si un estado realmente no se puede alcanzar, la operación se aparca como carta muerta (dead-letter) y se te muestra en lugar de fallar en silencio: verás un indicador **degradado** y podrás reintentar.

## Hot-swap: actívalo y desactívalo con seguridad

El vínculo con Jira es **por spec**, capturado en el momento en que lanzas un rail, no un interruptor global de todo-o-nada sobre el tablero. Eso hace que sea seguro alternarlo:

- **Activar o desactivar** la integración nunca recoloca tus specs existentes.
- **Desconectar** devuelve tu proyecto al comportamiento normal de specs locales.
- Las specs que ya tienen un vínculo con Jira conservan su escritura; las que no, se quedan como están.

Así que puedes experimentar con libertad —actívalo, ejecuta unos cuantos rails, desactívalo— sin desbaratar tu tablero ni tus specs locales.

## El día a día

Una vez conectado, la página de Ajustes del proyecto muestra una **tarjeta de conexión** donde puedes:

- **Sincronizar ahora** — fuerza un sondeo inmediato en lugar de esperar al temporizador.
- **Reintentar cartas muertas** — vuelve a ejecutar cualquier escritura que se haya quedado atascada.
- **Interruptor de hot-swap** — pausa/reanuda la integración temporalmente.
- **Desconectar** — separa el tablero de forma limpia.

Las specs respaldadas por Jira muestran una **insignia con la clave de Jira** (como `PROJ-123`) en su tarjeta, y al hacer clic enlazan de vuelta al issue. También recibirás pequeñas notificaciones cuando una sincronización se complete, cuando un token de autenticación expire (para que lo refresques) o cuando la integración entre en estado degradado.

## Cosas que tener en cuenta

- **Sondeo, no webhooks.** Como Specrails se ejecuta en local, sondea Jira en busca de cambios entrantes en lugar de recibir notificaciones push. Los cambios aparecen dentro del intervalo de sondeo, no al instante.
- **Un tablero por proyecto.** Distintos proyectos pueden sincronizar con distintos tableros; un único proyecto sincroniza con exactamente uno.
- **Gana la última escritura** en los conflictos, para el caso poco frecuente en que dos pestañas editan el mismo borrador a la vez.

## Desactivarlo

Si en algún momento quieres dar marcha atrás del todo, simplemente **Desconecta** desde Ajustes. Tus specs vuelven al comportamiento solo-local y los metadatos de Jira simplemente quedan sin uso: no se destruye nada.
