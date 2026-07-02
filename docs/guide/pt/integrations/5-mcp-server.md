# Controlar o Specrails a partir de qualquer IA (servidor MCP)

O Specrails pode expor-se **a si próprio** a qualquer assistente de IA que fale o [Model Context Protocol](https://modelcontextprotocol.io) — Claude Desktop, Claude Code, Cursor, Cline ou o seu próprio agente. Ative-o, aponte o seu assistente para o Specrails e poderá conduzir a app inteira conversando: *"lista os meus projetos", "cria uma spec para login social no projeto da API", "lança o rail 0 e avisa-me quando terminar", "quanto gastei esta semana?"*. O seu assistente invoca as ferramentas do Specrails nos bastidores em vez de ser você a clicar por toda a parte.

Este é o sentido oposto das funcionalidades de plugins e "Os meus MCPs aprovados": essas permitem que o Specrails *use* outros servidores MCP; esta permite que outras apps usem o **Specrails**.

## Como ativar

Está **desativado por predefinição**. Abra **Definições ▸ MCP** e ligue o **Enable MCP**. É só isso — o servidor arranca imediatamente, sem reiniciar.

Mantém o controlo *do que* uma IA externa pode fazer através de um conjunto de níveis de permissão:

| Nível | O que permite | Predefinição |
|---|---|---|
| **Leitura** | Listar e inspecionar projetos, specs, trabalhos, análises… | Sempre ativo (quando o MCP está ativado) |
| **Escrita** | Criar e editar specs, alterar definições e configuração de rails | Desativado — ativação opcional |
| **Invocação de IA** | Ações que correm uma IA e **custam dinheiro** (lançar um rail, gerar uma spec, enviar um turno de chat) | Desativado — ativação opcional |
| **Destrutivo** | Eliminar projetos/specs/trabalhos, parar trabalho em curso | Desativado — ativação opcional |

Se o seu assistente tentar algo abrangido por um nível desativado, o Specrails recusa com uma mensagem clara que lhe diz qual o nível a ativar. Assim, pode começar apenas em modo de leitura e abrir exatamente aquilo de que precisa.

## Ligar o seu assistente

O painel mostra um bloco de configuração pronto a colar. O caminho mais simples e universal é a **ponte** (bridge) incorporada (`specrails-mcp`): o seu assistente executa-a e ela retransmite para o Specrails por si. A ponte lê o token de acesso localmente, por isso **o token nunca aparece na configuração do seu assistente**.

Num cliente como o Claude Desktop ou o Cursor, a configuração tem este aspeto:

```json
{ "mcpServers": { "specrails": { "command": "specrails-mcp" } } }
```

Os clientes que suportam servidores MCP HTTP remotos podem, em alternativa, apontar diretamente para `http://127.0.0.1:4200/api/mcp` com o token do painel.

### Pelo terminal: Claude Code, Gemini CLI, Codex CLI

Copie seu token em **Configurações ▸ MCP ▸ Copiar token** e depois:

```bash
# Claude Code
claude mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <seu token>"

# Gemini CLI
gemini mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <seu token>"

# Codex CLI (stdio — registre o comando do bridge mostrado em Configurações ▸ MCP)
codex mcp add specrails -- <comando do bridge de Configurações ▸ MCP>
```

O cabeçalho `Authorization: Bearer <token>` também funciona. Se você mudou a porta do app, troque `4200`.

Uma vez ligado, o seu assistente vê cerca de **18 ferramentas** que cobrem a app inteira — projetos, specs, rails e trabalhos, chat/Explore, agentes, plugins, Jira, loops, o explorador de código, análises, definições — mais uma ferramenta de **guia** incorporada que lê primeiro, para que perceba como o Specrails funciona sem que lhe explique seja o que for.

## O que pode fazer com ele

Algumas receitas assim que o seu assistente estiver ligado. Comece com a **Leitura** ativa e, depois, ligue a **Escrita** e a **Invocação de IA** quando quiser que ele crie e lance trabalho de verdade.

**Transforme em specs o trabalho das suas outras ferramentas.** Se o seu assistente também tiver o GitHub, o Jira, o Gmail ou o Slack ligados, ele pode trazer esse trabalho para o Specrails por si:
> *"Pega nas issues abertas do GitHub desta semana com a etiqueta 'bug', cria uma spec para cada uma no projeto da API e lança-as."*
>
> *"Lê os meus emails de feedback de clientes mais recentes, agrupa-os por tema e cria uma spec por tema."*

**Piloto automático durante a noite.** Deixe-o a correr com a app no tabuleiro (tray) e volte para encontrar um relatório:
> *"Aqui estão 12 ideias. Transforma cada uma numa spec, lança-as três de cada vez pelos rails, vigia todos os trabalhos e amanhã dá-me um resumo do que terminou, do que falhou e do que custou."*

Mantenha o **Destrutivo** desativado e ele pode trabalhar a noite toda sem nunca eliminar nada.

**Em todos os seus projetos.** Algo que o painel não faz por si só:
> *"Verifica todos os meus projetos. Diz-me quais têm specs no backlog e nenhum rail a correr, e arranca o de prioridade mais alta em cada um."*

**Sem usar as mãos enquanto programa.** Conduza o Specrails a partir do seu editor ou por voz, sem trocar de janela:
> *"Lança o rail 0 em modo Freestyle com o Opus para o ticket #42 e avisa-me quando estiver pronto."*

**Pergunte sobre custos e histórico.** As suas análises, em linguagem simples:
> *"Onde gastei mais em IA esta semana, por projeto e por modelo? Mostra-me os cinco tickets mais caros."*

**O seu standup diário.**
> *"Escreve o meu standup: que rails correram ontem, o que terminou, o que falhou, o custo total — em tópicos prontos a colar no Slack."*

**Perceba o código.** Sem precisar de editor:
> *"Que ficheiros é que o ticket #38 tocou? Resume numa linha o que mudou em cada um."*

Como o seu assistente lê primeiro o guia incorporado, raramente precisa de nomear ferramentas ou specs — descreva o resultado e ele descobre as chamadas certas.

## Algumas coisas a saber

- **O Specrails tem de estar a correr.** O servidor MCP vive dentro da app, por isso o seu assistente só lhe consegue chegar enquanto o Specrails está aberto. Graças ao tabuleiro (tray), fechar a janela mantém-no a correr em segundo plano — só o **Exit** a partir do tabuleiro (barra de menus no Mac / área de notificação no Windows) é que efetivamente o para.
- **As ações longas transmitem em fluxo.** Lançar um rail ou gerar uma spec devolve resultado de imediato e termina em segundo plano; o seu assistente pode "vigiá-lo" e relatar quando estabilizar.
- **Segurança.** O MCP usa o seu próprio token de acesso, separado de tudo o resto, e escuta apenas na sua própria máquina (loopback). Pode copiar ou regenerar esse token a qualquer momento a partir do painel.
- **Não exposto (v1).** Por segurança, algumas capacidades de risco elevado são deliberadamente deixadas de fora: correr comandos de shell no terminal, o browser embutido, a edição de ficheiros dentro da app e a instalação de pré-requisitos do sistema. Tudo o que *gere* o Specrails está disponível; o acesso direto à máquina não está.

Pode desativar o MCP a qualquer momento a partir do mesmo painel — o seu assistente simplesmente perde o acesso, e mais nada muda.
