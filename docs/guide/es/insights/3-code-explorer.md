# Code explorer

La sección **Code** te da una ventana amigable y de solo lectura a tu repositorio, pensada especialmente para quienes quieren entender lo que la IA ha estado construyendo sin vivir dentro de un editor. Tienes un árbol de archivos a la izquierda, un visor de código a la derecha y, encima del código, un resumen en lenguaje sencillo de lo que hace realmente cada archivo.

En esta versión es estrictamente de solo lectura: nada de lo que hagas aquí cambia tus archivos. Piensa en ello como una sala de lectura, no como un taller.

Ábrela desde la barra lateral derecha (**Code**) y, como todo lo demás, está acotada a tu proyecto actual.

## El árbol de archivos

El panel izquierdo es un árbol virtualizado de los archivos de tu proyecto: rápido incluso en repositorios grandes. Respeta tu `.gitignore` y una lista de exclusión integrada, así que ves los archivos que importan, no un mar de artefactos de compilación y `node_modules`.

Junto a los archivos verás **chips de procedencia**: pequeñas marcas que te indican que un archivo fue *tocado por IA*. Esto es el corazón del Code explorer: Specrails registra qué archivos creó o modificó cada job del pipeline y los vincula al ticket que originó el trabajo. Así puedes responder, de un vistazo, "¿esto lo escribió la IA o lo escribí yo?".

En la parte superior del árbol hay un filtro:

- **Tocado por IA / Touched by AI** (el valor por defecto) — solo los archivos que la IA ha cambiado.
- **Todos los archivos** — el árbol completo.

Tu elección se recuerda por proyecto, así que si te interesan sobre todo los cambios hechos por IA los verás primero cada vez.

## El visor de código

Haz clic en un archivo y se abre en un visor completo (impulsado por Monaco, el mismo motor que VS Code) con resaltado de sintaxis adecuado que coincide con el tema que hayas elegido en la aplicación. Unos límites razonables mantienen todo fluido: los archivos binarios se rechazan con educación, y los archivos muy grandes (más de 2 MB) no se cargan.

Tu archivo actual se guarda en la URL de la página, así que puedes marcar como favorito o compartir un enlace directo a un archivo concreto.

Como en esta versión la edición no forma parte del paquete, el visor ofrece un botón **Editar en un editor externo** que copia la ruta absoluta del archivo: pégala en tu editor favorito y continúa allí.

## Resúmenes con IA

Encima del código verás un **resumen en lenguaje sencillo** del archivo —para qué sirve, qué hace— escrito de forma que cualquiera sin perfil técnico pueda seguirlo. Se generan por ti y se guardan en caché, así que abrir un archivo que ya has mirado antes es instantáneo.

Los resúmenes son listos a la hora de mantenerse al día: están vinculados al contenido del archivo, de modo que cuando un archivo cambia de verdad el resumen se regenera, pero los archivos sin cambios no se vuelven a resumir sin necesidad. Si editas un archivo tú mismo, su resumen se marca como obsoleto en vez de regenerarse en silencio: tú mantienes el control de cuándo se refresca. Hay una acción de **regenerar** para cuando quieras una versión fresca al momento.

Un par de salvaguardas mantienen los costes a raya: la generación de resúmenes se ejecuta dentro de un **presupuesto mensual** (unos pocos dólares por defecto, configurable en Ajustes), y hay topes de cuántos resúmenes lanzará un mismo job. Si se omite un resumen, la aplicación te dice por qué: presupuesto alcanzado, un tope por job, o que el archivo simplemente no se encuentra.

También puedes elegir el **idioma del resumen** (inglés o español) en los ajustes globales, dentro del área *Code section*.

## La historia de construcción

Bajo el visor de código vive la **historia de construcción**: una línea de tiempo cronológica con cada spec y cada trabajo que construyó el archivo que estás viendo. Cada capítulo es una tarjeta: qué spec intervino (con su estado actual), cuándo, si el archivo se creó, se modificó o se eliminó, y el tamaño del cambio (líneas añadidas y eliminadas). Haz clic en una tarjeta para abrir el detalle de esa spec. Los raíles basados en loops también registran los archivos que tocan, así que el trabajo hecho en worktrees aislados aparece en la historia igual que los trabajos normales del pipeline.

Para cualquier capítulo puedes pedir una explicación en lenguaje llano: pulsa **Explicar este cambio** y la app escribe de una a tres frases describiendo qué aportó ese cambio concreto al archivo, sin código ni jerga. Las explicaciones comparten el mismo presupuesto mensual que los resúmenes de archivos, y mientras no se genere una, la tarjeta recurre a los hechos que conoce: el tipo de cambio, la spec y la fecha. ¿Prefieres los datos en crudo? Un selector **Historia / Registro** cambia a la lista clásica de cambios con diffs bajo demanda. El mismo panel aparece en la vista **Files** del modo Agente.

## Conectar el código con las specs

El vínculo de procedencia funciona en ambos sentidos. Dentro del Code explorer, hacer clic en el chip de un ticket sobre un archivo abre el detalle de ese ticket. Y en sentido inverso, la vista de **detalle del ticket** tiene una sección *Archivos tocados por este ticket*: haz clic en un archivo ahí y saltas directo al Code explorer con él abierto. Cierra el círculo entre "esta es la spec que escribimos" y "este es el código que salió de ella".

## Lo que (todavía) no hace

Para dejar las expectativas claras, esta primera versión deja fuera a propósito algunas cosas: la edición dentro de la aplicación, los resúmenes por símbolo o por directorio, una vista de diff narrativa y el "pregúntale a la IA sobre este archivo" conversacional. La procedencia atribuye un archivo solo a su ticket principal. Son el tipo de cosas que podrían crecer con el tiempo.

## Desactivarlo

El Code explorer está activado por defecto. Puede desactivarse con los flags `VITE_FEATURE_CODE_EXPLORER` (cliente) o `SPECRAILS_CODE_EXPLORER` (servidor) — pon cualquiera de los dos a `false`. Desactivarlo deja todos tus datos registrados y resúmenes a salvo en el disco, intactos, por si vuelves a activarlo.
