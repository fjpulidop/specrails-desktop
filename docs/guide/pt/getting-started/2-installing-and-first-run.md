# Instalação e primeira utilização

Pôr o specrails a funcionar na sua máquina leva uns dois minutos. Aqui fica o fluxo completo.

## 1. Descarregar e instalar

Vá buscar o instalador para a sua plataforma:

- **macOS (Apple Silicon)** — um ficheiro `.dmg`. Abra-o e arraste o **specrails** para a sua pasta Aplicações.
- **Windows** — um instalador `.exe`. Execute-o e siga as instruções.

> **Atenção aos avisos de segurança no macOS e no Windows**
>
> - No **Windows**, o instalador ainda não está assinado digitalmente, por isso o SmartScreen pode mostrar um aviso. Clique em **Mais informações → Executar mesmo assim** para continuar.
> - No **macOS**, a app está assinada e notarizada, por isso deverá abrir sem problemas.

## 2. O que vai precisar (pré-requisitos)

O specrails corre pipelines de desenvolvimento com IA conduzindo ferramentas de linha de comandos reais, por isso há algumas coisas que precisam de estar disponíveis. A boa notícia: a app de desktop **já traz a maioria delas incluída** (o Node.js, o npm e o Git vêm dentro da app), por isso numa máquina nova normalmente não há nada para instalar.

A única coisa que o specrails não consegue incluir é a própria **CLI do fornecedor de IA**. Vai precisar de pelo menos uma de:

- **Claude Code**
- **Codex CLI**
- **Gemini CLI**

Instale aquela que planeia usar, inicie sessão nela uma vez a partir do seu terminal, e está tudo a postos. O specrails deteta automaticamente quais os fornecedores presentes.

> Se alguma vez vir uma ferramenta assinalada como em falta, a app mostra uma ligação **Mais informações** com comandos de instalação prontos a copiar e colar, adaptados ao seu sistema operativo (Homebrew no macOS, winget no Windows, apt/dnf no Linux). Pode voltar a verificar a qualquer momento sem reiniciar.

## 3. Primeira utilização — o ecrã de boas-vindas

Da primeira vez que abrir o specrails, vai dar com um **ecrã de boas-vindas** limpo. Ainda não há projetos, por isso a app convida-o a adicionar o primeiro.

Vai ver:

- Uma breve descrição do que o specrails faz.
- Um único botão **Adicionar o seu primeiro projeto**.

É todo o processo de arranque — sem conta para criar, sem registo. O specrails funciona inteiramente na sua máquina.

Clique em **Adicionar o seu primeiro projeto** e continue para [Adicionar o seu primeiro projeto](adding-your-first-project).
