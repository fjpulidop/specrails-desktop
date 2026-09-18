# Motores de IA locales

Ejecuta Specrails con modelos que alojas tú — Ollama, llama.cpp, LM Studio, vLLM o cualquier servidor que hable la API de chat-completions de OpenAI. Una vez conectado, un endpoint local es un motor como cualquier otro: aparece en la cabecera del rail, en Añadir spec (Quick y Explore), en el chat lateral y en las misiones del agente.

## Conectar un endpoint

1. Abre **Ajustes ▸ Agentes Specrails ▸ Conexiones de proveedor** y elige **Añadir motor local**.
2. Indica un id, la URL base (por ejemplo `http://127.0.0.1:11434/v1`) y, si tu servidor necesita clave, el **nombre de la variable de entorno** que la contiene. La clave nunca se guarda: Specrails la lee del entorno de la app al iniciar cada ejecución.
3. Pulsa **Probar conexión**. La píldora se pone verde cuando el servidor responde y se listan los modelos que sirve. Elige un modelo por defecto.
4. **Guardar**. El motor queda disponible al instante, sin reiniciar.

> Al abrir la app desde Finder, el Dock o el menú Inicio no se heredan los exports de la shell. Si la tarjeta dice que la variable *no está definida en el proceso de la app*, defínela a nivel de sistema o arranca la app desde un terminal que la tenga. Los servidores sin clave no necesitan nada.

Cada conexión tiene además un ajuste **Bucle del agente**. **Compacto** (por defecto) guía a los modelos pequeños con pasos cortos y estructurados: es lo que permite que un modelo de 7–14B supere el implement; **Libre** es el bucle agéntico clásico para modelos potentes (~30B+). Ajusta la **ventana de contexto** al tamaño real de tu servidor para que Specrails compacte antes de que el servidor rechace una petición.

## Qué obtienes

- Rails (implement, batch, freestyle, loops personalizados), Explore y specs Quick, chat y misiones se ejecutan con el modelo local.
- Las misiones conservan sus herramientas Specrails y tus servidores MCP externos.
- Las sesiones se reanudan entre turnos; los jobs interactivos funcionan.
- El coste es honesto: se registran los tokens, el coste queda *desconocido* salvo que indiques tarifas (entonces se marca *estimado*).

No disponible en motores locales: perfiles de agente y roles personalizados, enriquecimiento SMASH / Contract Layer, adjuntos y telemetría del pipeline. El Project Builder funciona en modo solo-salida (sin herramientas); su contrato de blueprint es estricto, así que usa un modelo capaz.

> Las misiones necesitan una **ventana de contexto grande** en el servidor (64k tokens o más): el prompt del operador más los schemas de herramientas de Specrails ocupan mucho. Chat y Explore van bien con 32k. Si un turno falla con *exceeds the available context size*, amplía la ventana (Ollama `OLLAMA_CONTEXT_LENGTH`, llama.cpp `-c`, LM Studio *Context Length*).

## ¿Solo tienes un motor local?

No hay nada que configurar. Specrails ofrece los motores que tu máquina puede ejecutar de verdad y elige el predeterminado con una única regla en todas partes: un CLI instalado (Claude → Codex → Gemini → Kimi) o, si no hay ninguno, el primer motor local cuyo endpoint responda. En una máquina con solo un endpoint local, los rails, Add Spec, el chat, **las misiones del agente y el Project Builder** arrancan en él sin tocar ningún selector. Un motor cuyo servidor está caído simplemente no se ofrece hasta que vuelva a responder. Las misiones existentes conservan el motor con el que se crearon; el selector sigue permitiendo cambiarlo.

## Elegir modelo

La calidad depende del modelo, no de Specrails. Para rails usa un modelo de código afinado para tool calling de 30B parámetros o más; los modelos instruct pequeños valen para chat, Explore y specs Quick. Prueba **Freestyle** o una sesión Explore antes de confiar un rail implement completo a un modelo nuevo.

## Desactivarlo

Define `SPECRAILS_LOCAL_ENGINES=false` en el entorno de la app para ocultar los motores locales en todas partes. Las conexiones guardadas se conservan y siguen valiendo como proveedores por rol del runtime programático.
