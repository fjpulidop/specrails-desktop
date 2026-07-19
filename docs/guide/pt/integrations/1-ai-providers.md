# Providers de IA (Claude, Codex, Gemini, Kimi)

O Specrails não está preso a uma única IA. Claude, Codex, Gemini e Kimi são
providers de primeira linha; cada superfície mostra apenas motores com as
capabilities exigidas pelo seu contrato.

## Os quatro providers

| Provider | CLI | Feito por | Notas |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Custo nativo e transporte interativo persistente. |
| **Codex** | `codex` | OpenAI | Requer codex `0.128.0+`. Lê os seus servidores MCP a partir do `~/.codex/config.toml` global. |
| **Gemini** | `gemini` | Google | Requer gemini `0.11.0+`. Usa telemetria nativa e um ficheiro de instruções `GEMINI.md`. |
| **Kimi Code** | `kimi` | Moonshot AI | Requer Kimi `0.27.0+`. O Desktop lança o CLI externo com `-p`; não instala nem inicia um servidor. |

Os quatro estão **ativados por omissão**. O provider aparece quando o CLI está
no `PATH`; para Kimi, confirme `kimi --version` e execute `kimi login`.

## Instalar um provider para um projeto

Quando adiciona um projeto, o assistente de configuração pergunta qual ou quais providers instalar. Escolha um, avance pelo passo de instalação e está feito. A partir daí o projeto simplesmente *tem* esse provider — nunca mais precisa de pensar nisso. Specs, rails, chat e analytics funcionam todos da mesma forma, independentemente do que escolheu.

Se um CLI que quer não aparecer em Adicionar Projeto, é quase sempre porque o CLI não está instalado ou não está no seu `PATH`. Instale-o e volte a abrir Adicionar Projeto.

## Instalar vários providers num só projeto

Pode instalar **mais do que um** provider no mesmo projeto — por exemplo Claude *e* Gemini. Em **Adicionar Projeto**, a lista de providers passa a ser um conjunto de caixas de seleção; marque tudo o que quiser. O primeiro que selecionar torna-se o provider **primário** (por omissão) do projeto; os restantes ficam disponíveis como alternativas.

Algumas coisas que vale a pena saber sobre projetos multi-provider:

- **Com um só provider, tudo se comporta exatamente como antes.** Se um projeto tiver apenas um provider, nunca verá um seletor de provider em lado nenhum — a app mantém-se limpa e simples.
- **As capabilities controlam a UI.** Claude e Kimi suportam perfis separados
  por provider; Codex e Gemini usam modo legacy.
- **A escolha de providers fica fixada após a criação.** Nesta versão escolhe os seus providers quando adiciona o projeto e não podem ser alterados mais tarde nas Definições. Se precisar de uma combinação diferente, isso é um projeto novo.

## Escolher um provider a cada invocação

A grande vantagem de um projeto multi-provider é poder escolher a IA certa para cada tarefa — sem mexer em nenhuma definição global. Sempre que uma IA corre, aparece um pequeno seletor de provider (apenas quando o projeto tem mais do que um):

- **Adicionar Spec** — Explore suporta Kimi; Quick Spec mostra apenas
  providers com um limite pure-output seguro e exclui Kimi.
- **Cabeçalho do rail** — escolha o motor para esse rail específico antes de o lançar.
- **Terminal** — o botão "Open AI CLI" (Sparkles) abre um menu de providers para que possa entrar em qualquer CLI instalado na diretoria desse projeto.

A sua escolha é guardada por projeto, predefinida para o provider primário, para que não tenha de a repetir de cada vez.

## Diferenças de capability

Kimi suporta Project/Agent Chat, Explore/propostas, Quick Launcher
(`/opsx:ff`), rails, Freestyle, loops sem Decider, perfis/roles manuais, MCP,
Serena, terminal e anexos.

`kimi -p` aprova ferramentas automaticamente e não consegue impor um limite
no-tools/read-only. São recusados antes do spawn: Quick Spec, AI Edit,
Contract Refine, SMASH/Re-SMASH, geração de blueprint/milestone no Project
Builder, Loop Decider, resumos/construction story e automação do Agent Studio.
Auto-title usa um fallback determinístico. Consulte o
[guia Kimi](../../../kimi.md).

## Acompanhamento de custos entre providers

**Analytics** regista invocações realmente iniciadas. Claude reporta custo;
Codex/Gemini usam estimativas. Kimi não reporta tokens ou custo USD
autoritativos, portanto os campos ficam vazios.

## Resolução de problemas

- **Um provider que instalei não aparece.** Confirme `claude --version` / `codex --version` / `gemini --version` / `kimi --version`.
- **Os servidores MCP do Codex não carregam no chat.** O Codex lê os servidores MCP a partir do `~/.codex/config.toml` global — registe-os aí com `codex mcp add`.
- **Desativar em emergência.** Um provider pode ser desligado em toda a app através de uma variável de ambiente (`SPECRAILS_CODEX_BETA=0` ou `SPECRAILS_GEMINI_BETA=0`). Isto só esconde o provider da *seleção*; raramente é necessário.

## Ver também

Consulte os guias dedicados a [Kimi](../../../kimi.md), Codex e Gemini.
