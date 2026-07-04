# Comande o Specrails conversando (Agent Chat)

O **Agent Chat** é um copiloto que vive *dentro* do Specrails e pode conduzir a aplicação inteira por você. Em vez de ficar clicando por projetos, specs, trilhos e análises, basta pedir: *«quantos jobs deram certo esta semana?»*, *«cria uma spec para o login social no projeto da API»*, *«lança os três tickets de maior prioridade e me avisa quando terminarem»*. Ele realiza o trabalho chamando as próprias ferramentas do Specrails — as mesmas que o [servidor MCP](./5-mcp-server.md) expõe — enquanto você vê o painel se atualizar ao vivo por trás dele.

> **Não confunda com os agentes do pipeline.** A seção *Agentes* (Architect → Developer → Reviewer) trata de *como um trilho implementa uma spec*. O **Agent Chat** é um único assistente que *opera a própria aplicação*. Coisas diferentes, mesma palavra.

## Como abrir

Há uma **bolha** flutuante na parte inferior da janela — clique nela para abrir o painel, ou pressione **⌘⇧A** (**Ctrl+Shift+A** no Windows/Linux) de qualquer lugar. O painel é uma janela de verdade que você pode mover, redimensionar, maximizar e devolver à bolha; ele lembra onde você o deixou.

Ele é **não modal de propósito**: o painel por trás continua vivo, então quando o agente lança um trilho ou cria uma spec você o vê aparecer em tempo real — não está olhando para uma tela congelada.

## Pré-requisito: o servidor MCP

O Agent Chat opera a aplicação através do **servidor MCP do Specrails** integrado, então ele precisa estar ativo. Se não estiver, o painel abre com um banner de **Ativar Specrails MCP** de um clique — pressione-o e está pronto (sem reiniciar). Veja [Controle o Specrails a partir de qualquer IA](./5-mcp-server.md) para os detalhes; nada é instalado, tudo é local na sua máquina.

## Escolher sobre o que ele trabalha

O cabeçalho tem um **seletor de projeto** (como o do Cursor). Escolha um projeto e tudo o que você pedir fica restrito a ele — *«lança os de alta prioridade»* se resolve contra esse projeto. Deixe-o em **Início** e o agente trabalha sobre toda a sua configuração: ele pode listar ou criar projetos e responder perguntas que abrangem tudo. Se você pedir algo específico de um projeto estando em Início, ele vai perguntar qual (ou se oferecer para criar um) em vez de adivinhar.

Escolher um projeto aqui **não** move o seu painel — o alvo do agente e o que você está vendo são independentes.

## Provedor e modelo

Logo acima da caixa de mensagem você escolhe o **provedor** (Claude, Codex ou Gemini) e o seu **modelo**. Cada provedor tem a sua própria lista de modelos, e trocar de provedor inicia uma sessão nova com o modelo padrão daquele provedor — assim você pode, por exemplo, conduzir a aplicação com o Claude e passar para o Codex em outra conversa sem que nada se misture.

## Níveis de permissão — a rédea está com você

O agente pode mexer na aplicação inteira, então você decide quanta liberdade ele tem por meio de um **nível** que você muda ao vivo pressionando **Shift+Tab** (o mesmo ciclo que o Claude Code usa). Cada nível inclui tudo o que está abaixo:

| Nível | O que ele pode fazer |
|---|---|
| 👀 **Observa** | Somente leitura — listar e inspecionar projetos, specs, jobs, análises. Nada muda. |
| ✍️ **Edita** | O acima **+** criar e editar (specs, ajustes, configuração de trilhos) — mudanças reversíveis. |
| ⚡ **Opera** | O acima **+** lançar trabalho de IA que **custa dinheiro** (trilhos, geração de specs). |
| 🔥 **Autônomo** | O acima **+** apagar e parar coisas — ações irreversíveis. |

Comece em **Observa** e suba o nível apenas quando quiser que o agente aja. Se ele tentar algo acima do nível atual, ele para e diz exatamente qual nível ativar — nunca contorna o limite. Isso é separado dos níveis de Ajustes ▸ MCP, que regem os assistentes *externos*; o nível aqui é só para este agente interno da aplicação.

## Algumas coisas que você pode pedir

Quando estiver em **Opera**, experimente:

> *«Lista todas as specs pendentes do projeto da API e depois lança as três de maior prioridade em trilhos separados e fica de olho nelas.»*
>
> *«Quanto gastei esta semana, detalhado por projeto?»*
>
> *«Cria uma spec para um botão de alternância de modo escuro no projeto web, com Contract Layer.»*
>
> *«Algo falhou no último lote — encontra os jobs que falharam e resume o porquê.»*

As respostas chegam de forma fluida e já formatadas (títulos, tabelas, listas), cada uma com um pequeno botão de **copiar**. Uma etiqueta de status embaixo mostra o que o agente está fazendo agora — *Pensando…*, *MCP · jobs*, *Terminal* — para que você sempre saiba o estado dele.

## Detalhes práticos

- **Super specs a partir de uma conversa.** Peça ao agente para *moldar* uma spec com você em vez de gerá-la de uma vez: ele lê primeiro o código real, faz algumas perguntas e mostra o rascunho em evolução como um cartão ao vivo dentro da conversa. Quando você diz sim, ele cria a spec e — por padrão — a enriquece em segundo plano com uma **Contract Layer** (caminhos de arquivo exatos, formas de dados, invariantes) para que os agentes que implementam não improvisem. Diga "sem contract layer" para pular o enriquecimento.
- **Clique no que ele menciona.** Em uma missão fixada a um projeto, os números de spec (`#12`) e os ids de job/execução nas respostas do agente são chips clicáveis: uma spec abre o modal de detalhe do quadro e um id de job abre a visão do job ao vivo. Se a referência não existir mais, você verá um aviso discreto de "não encontrado".
- **O cartão de implementação, sempre à vista.** Quando o agente implementa specs, um cartão ao vivo acompanha o trabalho — e enquanto ele precisar de algo de você (criar a PR, publicá-la, tentar de novo, descartar) fica **fixado logo acima da caixa de mensagem**, por mais que a conversa role; no lugar dele no histórico aparece um marcador discreto de "fixado acima". Vários cartões ativos se empilham como pequenos chips (clique em um para trazê-lo à frente), e um chevron minimiza o cartão para uma barra fina. Quando a PR é publicada — ou o trabalho é mesclado ou descartado — o cartão volta ao seu lugar no histórico da conversa.
- **Histórico de prompts.** Com a caixa vazia, pressione **↑**/**↓** para percorrer o que você perguntou antes (mostrado esmaecido enquanto rola); comece a digitar para editar, ou pressione Enter para enviar.
- **Edite a fila.** Enviou mais enquanto o agente estava ocupado? Enquanto houver mensagens na fila, **↑**/**↓** percorre *essas* mensagens: a caixa mostra a selecionada, você a edita ali mesmo e **Enter a salva de volta na fila** (Esc cancela; seu rascunho não enviado volta intacto).
- **Minimize sem perder nada.** Clique no ✕ para devolver o painel à bolha — a conversa continua rodando. Reabra e você chega na mensagem mais recente; nada é redigitado.
- **Nova conversa.** O botão **+** inicia um fio limpo; o histórico vive no nível da aplicação, acima de qualquer projeto individual.
- **Troque de missão.** O seletor de missões ao lado do seletor de projeto lista suas conversas da mais recente para a mais antiga — um ponto pulsante marca aquelas em que o agente ainda está trabalhando, e um pequeno selo conta as mensagens na fila. A busca aparece quando a lista passa de oito, e o ícone de lixeira de cada linha exclui uma missão após uma confirmação rápida em linha — mesmo uma em andamento (ele avisa primeiro e depois para o agente).

## Algumas coisas para saber

- **Opera e Autônomo custam dinheiro** porque executam IA. O agente destaca as ações que geram custo antes de fazê-las; mantenha o nível em Observa ou Edita se você só quer olhar e organizar.
- **O agente é de toda a aplicação**, não está atrelado ao projeto que você tem aberto — é por isso que ele tem o próprio seletor e o histórico dele não é por projeto.
- **Ele é tão capaz quanto o MCP permitir.** Se uma área inteira parecer bloqueada, verifique se o servidor MCP está ativado.
