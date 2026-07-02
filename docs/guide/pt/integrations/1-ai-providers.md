# Providers de IA (Claude, Codex, Gemini)

O Specrails não está preso a uma única IA. Todas as partes da app que falam com uma IA — Explore Spec, spec rápida (Quick), rails, chat, AI Edit, o botão "Open AI CLI" do terminal — podem correr através de qualquer um dos três providers de primeira linha. Você escolhe quais é que cada projeto usa e pode até alternar tarefa a tarefa.

## Os três providers

| Provider | CLI | Feito por | Notas |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | O mais completo. O único provider para Agentes (perfis) e rails Freestyle, e para o Contract Refine. |
| **Codex** | `codex` | OpenAI | Requer codex `0.128.0+`. Lê os seus servidores MCP a partir do `~/.codex/config.toml` global. |
| **Gemini** | `gemini` | Google | Requer gemini `0.11.0+`. Usa telemetria nativa e um ficheiro de instruções `GEMINI.md`. |

Os três estão **ativados por omissão**. Um provider aparece em **Adicionar Projeto** sempre que o seu CLI estiver instalado e no seu `PATH`. Por isso o primeiro passo é sempre o mesmo: instale o CLI que quer e autentique-se com ele, exatamente como a documentação dessa ferramenta descreve. Assim que `claude --version` (ou `codex`, ou `gemini`) funcionar no seu terminal, o Specrails consegue usá-lo.

## Instalar um provider para um projeto

Quando adiciona um projeto, o assistente de configuração pergunta qual ou quais providers instalar. Escolha um, avance pelo passo de instalação e está feito. A partir daí o projeto simplesmente *tem* esse provider — nunca mais precisa de pensar nisso. Specs, rails, chat e analytics funcionam todos da mesma forma, independentemente do que escolheu.

Se um CLI que quer não aparecer em Adicionar Projeto, é quase sempre porque o CLI não está instalado ou não está no seu `PATH`. Instale-o e volte a abrir Adicionar Projeto.

## Instalar vários providers num só projeto

Pode instalar **mais do que um** provider no mesmo projeto — por exemplo Claude *e* Gemini. Em **Adicionar Projeto**, a lista de providers passa a ser um conjunto de caixas de seleção; marque tudo o que quiser. O primeiro que selecionar torna-se o provider **primário** (por omissão) do projeto; os restantes ficam disponíveis como alternativas.

Algumas coisas que vale a pena saber sobre projetos multi-provider:

- **Com um só provider, tudo se comporta exatamente como antes.** Se um projeto tiver apenas um provider, nunca verá um seletor de provider em lado nenhum — a app mantém-se limpa e simples.
- **A barra lateral direita só mostra as secções que todos os providers instalados suportam.** Como os Agentes (perfis) são um conceito exclusivo do Claude, a secção **Agentes** desaparece assim que um projeto inclui qualquer provider que não seja Claude. Todo o resto (Specs, Código, Analytics, Integrações, Terminal, Chat) permanece.
- **A escolha de providers fica fixada após a criação.** Nesta versão escolhe os seus providers quando adiciona o projeto e não podem ser alterados mais tarde nas Definições. Se precisar de uma combinação diferente, isso é um projeto novo.

## Escolher um provider a cada invocação

A grande vantagem de um projeto multi-provider é poder escolher a IA certa para cada tarefa — sem mexer em nenhuma definição global. Sempre que uma IA corre, aparece um pequeno seletor de provider (apenas quando o projeto tem mais do que um):

- **Adicionar Spec** — um seletor de motor permite-lhe Explorar ou gerar rapidamente (Quick) uma spec com o provider que preferir.
- **Cabeçalho do rail** — escolha o motor para esse rail específico antes de o lançar.
- **Terminal** — o botão "Open AI CLI" (Sparkles) abre um menu de providers para que possa entrar em qualquer CLI instalado na diretoria desse projeto.

A sua escolha é guardada por projeto, predefinida para o provider primário, para que não tenha de a repetir de cada vez.

## O que só o Claude consegue fazer

Algumas funcionalidades são, por natureza, específicas do Claude, por isso ficam escondidas ou são ignoradas quando outro provider está em jogo:

- **Agentes (perfis)** — o catálogo de agentes por projeto e o roteamento de modelos. Escondido em qualquer projeto que inclua um provider que não seja Claude.
- **Rails Freestyle** — correm sempre no Claude.
- **Contract Refine** — a passagem extra de "Contract Layer" sobre uma spec confirmada só corre quando o provider da conversa é o Claude.
- **Modos avançados de Adicionar Spec** (SMASH / Contract Layer) — escondidos para motores que não sejam Claude.

Todo o resto — Explore, spec rápida (Quick), o pipeline completo de rails, AI Edit, chat, analytics de custos — funciona nos três.

## Acompanhamento de custos entre providers

A página **Analytics** acompanha cada invocação faturável, independentemente do provider. Em projetos multi-provider acrescenta chips de filtro por motor para que possa comparar o gasto por provider. O Claude reporta o seu próprio custo exato; para o Codex e o Gemini, o Specrails estima o custo a partir de uma tabela de preços incorporada, por isso os valores são aproximações próximas e não montantes faturados.

## Resolução de problemas

- **Um provider que instalei não aparece.** Confirme que o CLI está no seu `PATH` (experimente `claude --version` / `codex --version` / `gemini --version` num terminal novo). A app sonda os CLIs dos providers através do `PATH` do seu sistema.
- **Os servidores MCP do Codex não carregam no chat.** O Codex lê os servidores MCP a partir do `~/.codex/config.toml` global — registe-os aí com `codex mcp add`.
- **Desativar em emergência.** Um provider pode ser desligado em toda a app através de uma variável de ambiente (`SPECRAILS_CODEX_BETA=0` ou `SPECRAILS_GEMINI_BETA=0`). Isto só esconde o provider da *seleção*; raramente é necessário.

## Ver também

Os guias dedicados a cada provider aprofundam cada CLI: o guia do Codex e o guia do Gemini cobrem cada um a configuração, o que funciona e as particularidades específicas de cada provider.
