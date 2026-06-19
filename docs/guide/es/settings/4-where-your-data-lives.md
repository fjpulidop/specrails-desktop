# Dónde viven tus datos

La versión corta: **Specrails mantiene tus repositorios impecables.** Cuando apuntas la app a uno de tus proyectos, no se instala dentro, no esparce archivos de configuración por todas partes ni reescribe nada que no le hayas pedido. Tu código sigue siendo tuyo, y limpio.

## Tu repo se mantiene limpio

Los archivos propios de Specrails —sus bases de datos, el estado por proyecto, las definiciones de agentes, los ajustes, la telemetría, los resúmenes y todo lo demás que necesita para funcionar— viven en un único hogar bien ordenado, dentro de tu directorio personal:

```
~/.specrails/
```

Esa carpeta es el espacio de trabajo privado de la app. Es donde residen el registro de proyectos, las bases de datos por proyecto, las herramientas empaquetadas y todas las piezas operativas. Tus repositorios de código reales nunca se usan como vertedero para nada de esto.

Esto significa que:

- El `.gitignore` de tu repo **no** lo reescribe la app.
- Tu repo no se llena de configuración de herramientas ni de directorios de estado ocultos.
- Eliminar un proyecto de Specrails no deja ningún desorden detrás en tu código.

Si has usado antes herramientas que añadían carpetas y archivos sin avisar por todo tu proyecto, esto es un cambio deliberado de rumbo. Specrails está hecho para que apuntarlo a un repo sea un **no-evento** para el historial de git de ese repo.

## Lo único que *sí* se commitea, por diseño

Hay exactamente una excepción intencionada, y es la razón de ser de la herramienta: **tus specs de OpenSpec.**

Las specs viven en tu repositorio, dentro de:

```
openspec/
```

Esto es a propósito. Tus specs son un **entregable**: un registro versionado y revisable de qué decidiste construir y por qué. Su sitio está junto a tu código, bajo seguimiento en git, visibles en los pull requests, compartidas con tu equipo. Ese es el valor: las specs no son estado desechable de borrador, son parte de la historia de tu proyecto.

Así que la regla es simple y honesta:

- **`openspec/`** → vive en tu repo, commiteado, por diseño.
- **Todo lo demás que Specrails necesita** → vive en `~/.specrails/`, fuera de tu camino.

## Por qué funciona así

Specrails ejecuta las herramientas de IA desde su propio espacio de trabajo privado (en `~/.specrails/`) y solo se asoma a tu repositorio real para lo que de verdad necesita tocarlo: leer tu código y escribir las specs que pediste. Las herramientas, las definiciones del framework y la contabilidad interna se quedan todas en la carpeta hogar de la app.

Lo que ganas tú: puedes añadir un proyecto, ejecutar pipelines, explorar specs y probar cosas con la confianza de que el árbol de trabajo y el historial de git de tu repositorio solo cambian de las maneras que esperarías: tus specs commiteadas y el código que escriben tus pipelines. Nada más se cuela.

## Eliminar un proyecto

Cuando eliminas un proyecto de Specrails, la app limpia su propio estado por proyecto en `~/.specrails/`. Las specs que ya estaban commiteadas en tu repo se quedan donde les corresponde —en tu repo— porque son tuyas.
