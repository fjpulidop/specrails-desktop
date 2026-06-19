# Instalación y primer arranque

Poner specrails en tu máquina te llevará un par de minutos. Aquí tienes todo el proceso.

## 1. Descarga e instala

Hazte con el instalador para tu plataforma:

- **macOS (Apple Silicon)** — un archivo `.dmg`. Ábrelo y arrastra **specrails** a tu carpeta de Aplicaciones.
- **Windows** — un instalador `.exe`. Ejecútalo y sigue los pasos.

> **Aviso sobre los avisos de seguridad de macOS y Windows**
>
> - En **Windows**, el instalador aún no está firmado, así que SmartScreen puede mostrar una advertencia. Haz clic en **Más información → Ejecutar de todas formas** para continuar.
> - En **macOS**, la app está firmada y notarizada, así que debería abrirse sin problemas.

## 2. Lo que vas a necesitar (requisitos previos)

specrails ejecuta pipelines de desarrollo con IA controlando herramientas de línea de comandos reales, así que hay algunas cosas que deben estar disponibles. La buena noticia: la app de escritorio **incluye la mayoría por ti** (Node.js, npm y Git vienen dentro de la app), así que en una máquina recién estrenada normalmente no hay nada que instalar.

Lo único que specrails no puede incluir es el **CLI del provider de IA** en sí. Necesitarás al menos uno de estos:

- **Claude Code**
- **Codex CLI**
- **Gemini CLI**

Instala el que tengas pensado usar, inicia sesión una vez desde tu terminal y listo. specrails detecta automáticamente qué providers están presentes.

> Si en algún momento ves una herramienta marcada como ausente, la app muestra un enlace de **Más información** con comandos de instalación listos para copiar y pegar, adaptados a tu sistema operativo (Homebrew en macOS, winget en Windows, apt/dnf en Linux). Puedes volver a comprobarlo en cualquier momento sin reiniciar.

## 3. Primer arranque — la pantalla de bienvenida

La primera vez que abras specrails, llegarás a una **pantalla de bienvenida** limpia. Todavía no hay proyectos, así que la app te invita a añadir el primero.

Verás:

- Una breve descripción de lo que hace specrails.
- Un único botón **Añadir tu primer proyecto**.

Eso es toda la puesta en marcha: ninguna cuenta que crear, ningún registro. specrails funciona por completo en tu máquina.

Haz clic en **Añadir tu primer proyecto** y continúa con [Añadir tu primer proyecto](adding-your-first-project).
