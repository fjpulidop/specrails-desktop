# Providers de IA (Claude, Codex)

## Os dois providers

| Provider | CLI | Feito por | Notas |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Custo nativo e transporte interativo persistente. |
| **Codex** | `codex` | OpenAI | Requer codex `0.128.0+`. Lê os seus servidores MCP a partir do `~/.codex/config.toml` global. |

## Os providers são detetados automaticamente

Se um provider que queres não aparece em lado nenhum, é quase sempre porque o
CLI não está instalado ou não está no teu `PATH`. Instala-o, inicia sessão e
volta à app — a deteção corre de novo ao focar a janela e o provider aparece
por si próprio em todo o lado, com a sua superfície de workspace montada em
segundo plano. Um provider instalado mas sem sessão iniciada continua a
aparecer, com um distintivo *Sem sessão iniciada* nos seletores de motor.

Algumas coisas úteis sobre máquinas multi-provider:

- **Um único provider comporta-se exatamente como antes.** Se só um for detetado, nunca verás um seletor de provider — a app mantém-se limpa e simples.
- **Nada fica bloqueado.** Instalar ou remover um CLI de provider atualiza todos
  os projetos automaticamente — não há definição de provider por projeto para gerir.

## Escolher um provider a cada invocação

A grande vantagem de um projeto multi-provider é poder escolher a IA certa para cada tarefa — sem mexer em nenhuma definição global. Sempre que uma IA corre, aparece um pequeno seletor de provider (apenas quando o projeto tem mais do que um):

- **Cabeçalho do rail** — escolha o motor para esse rail específico antes de o lançar.
- **Terminal** — o botão "Open AI CLI" (Sparkles) abre um menu de providers para que possa entrar em qualquer CLI instalado na diretoria desse projeto.

A sua escolha é guardada por projeto, predefinida para o provider primário, para que não tenha de a repetir de cada vez.

## Resolução de problemas

- **Os servidores MCP do Codex não carregam no chat.** O Codex lê os servidores MCP a partir do `~/.codex/config.toml` global — registe-os aí com `codex mcp add`.
