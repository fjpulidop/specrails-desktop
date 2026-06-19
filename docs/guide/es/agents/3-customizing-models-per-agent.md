# Personalizar los modelos por agente

Lo más útil que te permiten hacer los perfiles es **elegir el modelo adecuado para cada paso**. Un paso de planificación quizá merezca tu modelo más potente; un paso de construcción rutinario seguramente esté la mar de contento con algo más rápido y barato. Los perfiles te dejan expresar exactamente eso.

Aquí es donde la separación entre lo compartido y lo que es por proyecto da sus frutos:

- Las *definiciones* de los agentes siguen siendo compartidas en todo tu equipo.
- El *modelo con el que corre cada agente* se configura **por proyecto**, dentro de un perfil, y solo afecta a tu proyecto.

Cambia un modelo y cambias el coste y el comportamiento para ese proyecto — sin tocar la configuración de nadie más ni las instrucciones subyacentes del agente.

## Cambiar qué modelo usa un agente

En **Agentes → Perfiles**, selecciona un perfil y abre su editor de cadena de agentes. Cada agente de la cadena tiene un campo de modelo. También hay un modelo **orquestador** que se encarga de la coordinación de alto nivel del pipeline.

Los valores de modelo son alias — para Claude son `opus`, `sonnet` y `haiku` (de más capaz → más rápido). Asigna el alias que quieras por agente:

- Deja el modelo de un agente **en blanco** para que recurra al default propio del archivo del agente.
- Asígnalo explícitamente para sobrescribirlo solo en este perfil.

Guarda, y el próximo rail lanzado con ese perfil usará los nuevos modelos. Los jobs que ya están en marcha conservan su snapshot.

## Crear perfiles como `fast` y `max`

El patrón natural es tener un par de perfiles con nombre a los que recurres según el trabajo:

**Un perfil `fast`** — para cambios pequeños y de bajo riesgo donde quieres velocidad y una factura más reducida:

- Architect: un modelo intermedio o rápido — el plan es simple.
- Developer: un modelo rápido — el cambio es mecánico.
- Reviewer: mantenlo sólido, aunque también puedes recortar aquí.

**Un perfil `max`** — para features espinosas y de mucho en juego donde quieres que cada paso sea lo más afilado posible:

- Architect, developer y reviewer: tu modelo más potente en todos los frentes.

### Dos formas de construir uno

1. **Duplicar y ajustar** *(recomendado).* Selecciona tu perfil `default`, **Duplícalo**, dale a la copia un nombre en kebab-case como `fast` o `max`, y luego ajusta el modelo de cada agente. Heredas una cadena y un enrutado que sabes que funcionan y solo cambias lo que pretendes cambiar.
2. **Empezar en blanco.** Crea un **Perfil en blanco** y monta la cadena tú mismo. Sigues teniendo que incluir el trío base (`sr-architect`, `sr-developer`, `sr-reviewer`) — el pipeline depende de los tres — y exactamente una regla de enrutado comodín terminal, que debe ir la última.

Los nombres de perfil van en minúsculas y kebab-case (p. ej. `fast`, `max`, `cheap-and-cheerful`).

## Enrutar tareas a agentes concretos

Las **reglas de enrutado** de un perfil deciden qué agente se encarga de una tarea etiquetada. Cada regla lista etiquetas de tarea y un agente de destino; gana la primera regla cuyas etiquetas coincidan, y una única regla `default: true` al final captura todo lo demás. Solo los agentes que están realmente en la cadena del perfil pueden ser destinos de enrutado — el editor lo obliga.

Para el uso del día a día no tocarás el enrutado: la regla comodín manda el trabajo al developer y eso es correcto. Echa mano de las reglas por etiquetas cuando quieras, por ejemplo, que el trabajo etiquetado como `migration` vaya a un especialista en lugar del developer.

## Elegir el perfil cuando lanzas

Todo esto se junta en el lanzamiento: en la cabecera del rail, elige `fast`, `max` o `default` por rail. Un lote puede mezclarlos — un arreglo diminuto en `fast`, una feature grande en `max`, ambos corriendo a la vez. Consulta [Perfiles y el equilibrado por defecto](profiles-and-the-balanced-default) para el flujo de selección.

## Una nota sobre seguridad

Eliminar un perfil es seguro para el trabajo en marcha: los jobs que ya se lanzaron con él conservan su snapshot, y los lanzamientos futuros simplemente recurren al orden de resolución. Experimenta sin miedo.

## A dónde ir después

- [Agentes personalizados y el catálogo](custom-agents-catalog) — añade agentes para meter en tus cadenas.
