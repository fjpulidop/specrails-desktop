# Controlar o Specrails a partir de qualquer IA (servidor MCP) {#mcp-server}

O Specrails pode expor-se **a si próprio** a qualquer assistente de IA que fale o [Model Context Protocol](https://modelcontextprotocol.io) — Claude Desktop, Claude Code, Cursor, Cline ou o seu próprio agente. Ative-o, aponte o seu assistente para o Specrails e poderá conduzir a app inteira conversando: *"lista os meus projetos", "cria uma spec para login social no projeto da API", "lança o rail 0 e avisa-me quando terminar", "quanto gastei esta semana?"*. O seu assistente invoca as ferramentas do Specrails nos bastidores em vez de ser você a clicar por toda a parte.

Este é o sentido oposto das funcionalidades de plugins e "Os meus MCPs aprovados": essas permitem que o Specrails *use* outros servidores MCP; esta permite que outras apps usem o **Specrails**.

## Vem ativado de origem

Está **ativado por predefinição** — o servidor já está a correr na primeira vez que abre a app, sem reiniciar nem ligar nada. Abra **Definições ▸ MCP** para copiar a configuração de cliente, ou para o desligar se não o quiser.

Mantém o controlo *do que* uma IA externa pode fazer através de um conjunto de níveis de permissão:

| Nível | O que permite | Predefinição |
|---|---|---|
| **Leitura** | Listar e inspecionar projetos, specs, trabalhos, análises… | Sempre ativo (quando o MCP está ativado) |
| **Escrita** | Criar e editar specs, alterar definições e configuração de rails | Ativado — desmarque para restringir |
| **Invocação de IA** | Ações que correm uma IA e **custam dinheiro** (lançar um rail, gerar uma spec, enviar um turno de chat) | Ativado — desmarque para restringir |
| **Destrutivo** | Eliminar projetos/specs/trabalhos, parar trabalho em curso | Ativado — desmarque para restringir |

Os quatro níveis vêm concedidos de origem, por isso um assistente ligado pode conduzir toda a app desde logo. Desmarque qualquer nível que prefira reservar para si; se depois o seu assistente tentar algo abrangido por esse nível, o Specrails recusa com uma mensagem clara que lhe diz qual o nível a voltar a ativar.

## Ligue o Claude Code ou o Codex num passo

Abra **Definições ▸ MCP** e clique em **Conectar** ao lado do Claude Code ou do Codex — ou execute um comando num terminal:

```bash
specrails-desktop mcp connect --client claude   # ou codex
```

O Specrails adiciona-se à configuração do próprio cliente, guarda um backup do ficheiro, não grava nenhum token de acesso e verifica a ligação de imediato (verá quantas ferramentas encontrou). Repetir não faz mal. Depois, abra uma nova sessão do Claude Code ou do Codex. **Copiar comando** mostra o comando do próprio cliente, se preferir executá-lo; para outros assistentes, use **Copiar configuração**.

Se algo não funcionar, execute `specrails-desktop mcp doctor`. Verifica tudo de uma vez (a app, o ficheiro do token de acesso, a ponte e o Node que a executa, a entrada de cada cliente e uma ligação real) e indica a solução para cada problema. Só observa; não altera nada. Depois de atualizar o Node (por exemplo com o Homebrew), volte a clicar em **Conectar** se o assistente deixou de encontrar o Specrails.

**Perguntar antes de gastar** (no mesmo painel, 0,50 $ por omissão) é o montante acima do qual um assistente ligado tem de te perguntar antes de começar trabalho pago. Merges, PRs e eliminações perguntam sempre. O teu assistente recebe um conjunto simples de 15 ferramentas com os próximos passos prontos, espera sem consultas repetidas, respostas no teu idioma e prompts como *start-my-day*, *review-waiting*, *ship-milestone* e *why-stuck*. Se um script antigo teu precisar das ferramentas anteriores, desativa **Ferramentas MCP simplificadas** no mesmo painel; as missões do próprio Specrails não são afetadas.

Cada decisão chega-te como um menu curto: as opções, cada uma com o que acontece se a escolheres, a recomendada primeiro e no fim "Outra coisa — escreva". Responde com o número (ou a opção) pelo teclado, ou com as tuas palavras. Se o teu cliente puder mostrar o seu próprio formulário, o Specrails pergunta-te aí diretamente; uma opção que integra, abre uma PR ou gasta dinheiro continua a pedir o teu sim.

## Só para agentes: ligar o seu cliente

Quando uma pessoa pedir a um agente para se ligar, leia o [guia de ligação MCP](https://github.com/fjpulidop/specrails-desktop/blob/main/docs/agents/mcp.md). Cobre a ligação com um comando, o registo manual no Claude Code e no Codex, a verificação e a resolução de problemas. Registar não prova a ligação: conclua `initialize`, `tools/list` e uma chamada só de leitura.

Para uma vista rápida de tudo, o assistente chama `specrails_overview`: o que está a correr, o que precisa de ti, as falhas recentes, o gasto de hoje e a CPU e a memória da máquina, numa só chamada. `specrails_inbox` lê e responde à caixa **Pendências**, `specrails_missions` lista as tuas missões e envia-lhes mensagens, `specrails_specs` e `specrails_rails` mostram o backlog e os rails de um projeto, `specrails_insights` o teu gasto e os teus limites, e `specrails_wait` espera que uma execução termine em vez de perguntar vezes sem conta. Uma execução falhada vem com o seu diagnóstico e o fim do seu registo.

Cada resposta começa com um resumo curto em linguagem simples e os próximos passos possíveis, com o recomendado assinalado, e os erros dizem o que correu mal e se vale a pena tentar de novo. Antes de algo irreversível, ou de trabalho pago acima do teu limite, o assistente mostra-te uma pré-visualização e pergunta primeiro. O teu sim só vale para essa ação exata e expira se algo mudar entretanto.

Antes de agir, o assistente pode pedir a `specrails_overview` um ponto de situação atual de um projeto: specs, execuções e estado do Git. As secções indisponíveis são indicadas explicitamente; não significam que o projeto esteja vazio. Também pode pesquisar e ler o teu código-fonte, linha a linha, sem o alterar.

Cada sessão MCP externa mantém a sua própria seleção de projeto. No modo Missão, o projeto predefinido é o que está fixado na conversa, que mudas na interface da missão; uma seleção MCP não o pode substituir. Indicar outro projeto numa chamada visa esse projeto de propósito.

## O que pode fazer com ele

Algumas receitas assim que o seu assistente estiver ligado. Está tudo ativo por predefinição; desmarque a **Escrita** ou a **Invocação de IA** em Definições ▸ MCP se por agora preferir que ele apenas observe.

**Transforme em specs o trabalho das suas outras ferramentas.** Se o seu assistente também tiver o GitHub, o Jira, o Gmail ou o Slack ligados, ele pode trazer esse trabalho para o Specrails por si:
> *"Pega nas issues abertas do GitHub desta semana com a etiqueta 'bug', cria uma spec para cada uma no projeto da API e lança-as."*
>
> *"Lê os meus emails de feedback de clientes mais recentes, agrupa-os por tema e cria uma spec por tema."*

**Piloto automático durante a noite.** Deixe-o a correr com a app no tabuleiro (tray) e volte para encontrar um relatório:
> *"Aqui estão 12 ideias. Transforma cada uma numa spec, lança-as três de cada vez pelos rails, vigia todos os trabalhos e amanhã dá-me um resumo do que terminou, do que falhou e do que custou."*

Desmarque o **Destrutivo** e ele pode trabalhar a noite toda sem nunca eliminar nada.

**Em todos os seus projetos.** Algo que o painel não faz por si só:
> *"Verifica todos os meus projetos. Diz-me quais têm specs no backlog e nenhum rail a correr, e arranca o de prioridade mais alta em cada um."*

**Sem usar as mãos enquanto programa.** Conduza o Specrails a partir do seu editor ou por voz, sem trocar de janela:
> *"Lança o rail 0 com o Opus para a spec #42 e avisa-me quando estiver pronto."*

**Pergunte sobre custos e histórico.** As suas análises, em linguagem simples:
> *"Onde gastei mais em IA esta semana, por projeto e por modelo? Mostra-me os cinco specs mais caras."*

**O seu standup diário.**
> *"Escreve o meu standup: que rails correram ontem, o que terminou, o que falhou, o custo total — em tópicos prontos a colar no Slack."*

**Perceba o código.** Sem precisar de editor:
> *"Que ficheiros é que a spec #38 tocou? Resume numa linha o que mudou em cada um."*

Como o seu assistente lê primeiro o guia incorporado, raramente precisa de nomear ferramentas ou specs — descreva o resultado e ele descobre as chamadas certas.

## Algumas coisas a saber

- **O Specrails tem de estar a correr.** O servidor MCP vive dentro da app, por isso o seu assistente só lhe consegue chegar enquanto o Specrails está aberto. Graças ao tabuleiro (tray), fechar a janela mantém-no a correr em segundo plano — só o **Exit** a partir do tabuleiro (barra de menus no Mac / área de notificação no Windows) é que efetivamente o para.
- **As ações longas transmitem em fluxo.** Lançar um rail ou gerar uma spec devolve resultado de imediato e termina em segundo plano; o seu assistente pode "vigiá-lo" e relatar quando estabilizar.
- **Segurança.** O MCP usa o seu próprio token de acesso, separado de tudo o resto, e escuta apenas na sua própria máquina (loopback). O token não pode fazer-se passar pelo modo Agente fornecendo cabeçalhos de nível, projeto ou conversa: o agente incorporado usa uma capacidade privada, de curta duração, emitida pelo servidor. Pode copiar ou regenerar o token com âmbito a qualquer momento a partir do painel.
- **Não exposto (v1).** Por segurança, os clientes MCP externos não podem correr comandos de shell em bruto no terminal, usar o browser embutido, editar ficheiros dentro da app nem instalar pré-requisitos do sistema. O modo Agente tem um caminho autenticado separado para comandos de fundo de longa duração confirmados com a permissão Autônomo; os clientes externos não o podem obter ativando o Destrutivo. Tudo o resto que *gere* o Specrails está disponível.

Pode desativar o MCP a qualquer momento a partir do mesmo painel — o seu assistente simplesmente perde o acesso, e mais nada muda.
