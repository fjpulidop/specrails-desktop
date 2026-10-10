# Entorno del proyecto

Algunos proyectos necesitan una credencial al ejecutarse, como `NODE_AUTH_TOKEN` para paquetes privados de npm. En **Ajustes del proyecto → Entorno**, añade los **nombres** de las variables que necesitan tus rails y loops. Specrails guarda solo los nombres, nunca los valores.

## De dónde salen los valores

Al iniciar una ejecución, Specrails lee cada nombre configurado del entorno con el que se abrió. Si abres Specrails desde el Dock o el Finder, ese entorno no incluye lo que exporta tu perfil de shell, así que Specrails también lee los nombres que faltan de tu login shell (por ejemplo `~/.zprofile` o `~/.zshrc`). Guarda la credencial real en tu perfil de shell, no en el repositorio.

La comprobación se hace en segundo plano al abrir el proyecto, al cambiar los nombres y periódicamente después, así que un perfil lento no retrasa tus ejecuciones. Los valores quedan en memoria solo para ese proyecto.

## Cómo leer los indicadores

Cada nombre guardado muestra un indicador:

| Indicador | Qué significa | Qué hacer |
|-----------|---------------|-----------|
| **Heredada** | Specrails se inició con la variable. | Nada. |
| **Del login shell** | Specrails la leyó de tu login shell. | Nada. |
| **No definida** | Tu login shell no la exporta. | Añade un `export` en tu perfil de shell. |
| **Shell agotó el tiempo** | Tu login shell tardó demasiado en arrancar. | Acelera el perfil o sube `SPECRAILS_LOGIN_SHELL_TIMEOUT_MS` (10 segundos por defecto). |
| **Fallo al leer el shell** | Specrails no pudo leer tu login shell. | Corrige el perfil o abre Specrails desde una terminal. |

Pasa el ratón por encima de un indicador para ver la explicación. Tras corregir el perfil, pulsa **Comprobar de nuevo**: no hace falta reiniciar Specrails.

Si una ejecución arranca con un nombre sin resolver, su log muestra una línea `[environment]` con la variable y su estado. La ejecución arranca igualmente. El valor nunca aparece en la app, en los logs ni en las herramientas MCP.

En Windows, Specrails usa solo el entorno con el que se inició.
