# Qué es specrails

Te damos la bienvenida a **specrails**, una app de escritorio que convierte a un asistente de programación con IA en un auténtico equipo de desarrollo que trabaja en *tus* proyectos, en *tu* máquina.

En lugar de copiar y pegar prompts de un lado a otro, describes lo que quieres como una **spec** y specrails la lleva a través de un pipeline de desarrollo completo —diseñando, construyendo, revisando y publicando el cambio— mientras lo ves suceder en directo.

## Desarrollo con IA guiado por specs

El corazón de specrails es una idea sencilla: **la mejor forma de conseguir buen código de una IA es partir de una spec clara.**

Una *spec* es una descripción breve y estructurada de un trabajo concreto: una funcionalidad, una corrección, un refactor. Puedes escribir una en segundos, o darle forma a través de un chat guiado que te hace las preguntas adecuadas y la redacta por ti. Cada spec se convierte en un **ticket** en el tablero de tu proyecto, igual que una tarea en cualquier gestor de incidencias.

A partir de ahí, le pasas la spec al pipeline y dejas que la IA haga el trabajo pesado.

## El pipeline: Architect → Developer → Reviewer → Ship

Cuando lanzas una spec, specrails la lleva a través de cuatro etapas, cada una interpretada por un agente de IA especializado:

1. **Architect** — lee tu spec y el código que la rodea, y luego planifica el cambio: qué archivos tocar y qué forma debería tener la solución.
2. **Developer** — escribe el código de verdad, siguiendo el plan.
3. **Reviewer** — comprueba que el trabajo sea correcto y de calidad, detectando problemas antes que tú.
4. **Ship** — finaliza el cambio para que quede listo para hacer commit.

Ves cada etapa a medida que se ejecuta, con logs en directo que llegan directamente de la IA. No se oculta nada: si algo se tuerce, verás exactamente dónde.

## Proyectos

Todo en specrails se organiza en torno a **proyectos**. Un proyecto no es más que una carpeta de tu ordenador que contiene una base de código. Puedes añadir tantos proyectos como quieras y cambiar entre ellos al instante; cada uno conserva sus propias specs, su historial de jobs, sus analíticas y sus ajustes.

specrails nunca toca código que no le hayas pedido tocar. Trabaja dentro de tu repositorio existente, y tú mantienes el control de lo que acaba en un commit.

## Elige tu provider de IA

specrails funciona con los principales CLI de programación con IA:

- **Claude** (Claude Code)
- **Codex** (Codex CLI)
- **Gemini** (Gemini CLI)

Elige el que ya uses, o instala más de uno y escoge según la tarea. Un proyecto puede funcionar con un único provider o con varios a la vez, así que nunca te quedas atado a uno.

## Por qué te va a gustar

- **Velocidad sin caos** — las specs mantienen a la IA centrada, así que obtienes cambios útiles en lugar de divagaciones interminables.
- **Visibilidad total** — logs en directo, una vista clara del pipeline y analíticas por proyecto te muestran exactamente qué pasó y cuánto costó.
- **Tu máquina, tu código** — todo se ejecuta en local contra tu repositorio real.
- **Todo en un solo sitio** — specs, jobs, chat, una terminal integrada y seguimiento de costes, todo en una única ventana.

¿Listo para empezar? Lo siguiente: [Instalación y primer arranque](installing-and-first-run).
