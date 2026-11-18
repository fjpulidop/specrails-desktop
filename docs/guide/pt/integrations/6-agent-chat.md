# Comande o Specrails conversando (Agent Chat)

O **Agent Chat** é um copiloto que vive *dentro* do Specrails e pode conduzir a aplicação inteira por você. Em vez de ficar clicando por projetos, specs, trilhos e análises, basta pedir: *«quantos jobs deram certo esta semana?»*, *«cria uma spec para o login social no projeto da API»*, *«lança as três specs de maior prioridade e me avisa quando terminarem»*. Ele realiza o trabalho chamando as próprias ferramentas do Specrails — as mesmas que o [servidor MCP](mcp-server) expõe — enquanto você vê o painel se atualizar ao vivo por trás dele.

> **Não confunda com os agentes do pipeline.** A seção *Agentes* (Architect → Developer → Reviewer) trata de *como um trilho implementa uma spec*. O **Agent Chat** é um único assistente que *opera a própria aplicação*. Coisas diferentes, mesma palavra.

## Como abrir

Há uma **bolha** flutuante na parte inferior da janela — clique nela para abrir o painel, ou pressione **⌘⇧A** (**Ctrl+Shift+A** no Windows/Linux) de qualquer lugar. O painel é uma janela de verdade que você pode mover, redimensionar, maximizar e devolver à bolha; ele lembra onde você o deixou.

Ele é **não modal de propósito**: o painel por trás continua vivo, então quando o agente lança um trilho ou cria uma spec você o vê aparecer em tempo real — não está olhando para uma tela congelada.

## Reutilizar o texto selecionado

Selecione texto numa conversa de missão para abrir o menu de contexto dele.

**Perguntar sobre isto** abre uma conversa à parte sobre a seleção, como uma pergunta rápida "a propósito". Digite uma pergunta, ou pressione Enter com a caixa vazia para que o texto seja explicado no contexto desta missão. A resposta usa a conversa anterior da missão, e você pode fazer outras perguntas em seguida. Nada é salvo: a missão, o compositor dela e a sessão do agente não são tocados, e fechar a janela descarta a conversa à parte. O rodapé indica o modelo que respondeu.

**Adicionar à missão**
envia-o para essa mesma missão, usando a fila normal se ela estiver ocupada, e mantém
o seu rascunho inacabado no compositor.

**Começar uma missão separada** oferece **Do zero** (apenas a seleção) e
**Com contexto · Fork** (o histórico e os anexos até a última mensagem
abrangida pela seleção, inclusive). Ambos adicionam um painel dividido, mantêm os painéis
existentes e colocam o texto selecionado no novo compositor para edição. Pressione Enter
quando estiver pronto; abrir a missão não envia nada. O fork usa a própria
sessão do agente e cópias dos arquivos, e mostra o título da missão original.
Os cards herdados são registros só de leitura; as ações deles não são repetidas.

Você também pode clicar com o botão direito na seleção ou pressionar **Shift+F10**. Use as setas para
percorrer o menu e **Escape** para fechá-lo. Selecione mensagens já confirmadas;
o texto ainda em streaming ou à espera na fila ainda não está disponível.

## Várias missões lado a lado {#split-view}

Clique com o botão direito numa missão da barra lateral (ou prima **Shift+F10**) e escolha **Vista dividida**, **Abrir à direita** ou **Abrir abaixo**. A vista dividida coloca-a ao lado da missão em que está quando há espaço para as duas; caso contrário, abaixo.

- **Redimensionar:** arraste a linha entre duas missões. Ela encaixa no meio; um duplo clique divide o espaço por igual. Com a linha em foco, as setas movem-na (Shift para passos maiores) e Home centra-a.
- **Menu de layout** (o botão de colunas no cabeçalho de cada missão): abrir outra missão à direita ou abaixo, mover a missão para a esquerda, direita, cima ou baixo, trocá-la com outra, maximizá-la, igualar todas as missões ou fechá-la. As opções que deixariam uma missão pequena demais (menos de cerca de 360 × 240 px) ficam desativadas.
- **Atalhos:** **⌥⌘]** / **⌥⌘[** missão seguinte ou anterior, **⌘⇧↵** maximizar ou restaurar, **⌥⌘=** igualar, **⌥⌘W** fechar a missão atual (no Windows/Linux, Ctrl+Alt em vez de ⌥⌘ e Ctrl+Shift+Enter).
- **Janelas pequenas:** quando as missões já não cabem, ficam empilhadas: uma fila de separadores no topo escolhe a que se vê e as outras continuam a correr.

O layout e os seus tamanhos são lembrados nesta janela entre reinícios; missões arquivadas ou eliminadas são descartadas. Fechar o painel de uma missão nunca a para nem a elimina.

## Quão cheio está o contexto {#context-ring}

Um pequeno anel ao lado da caixa de mensagem mostra quanto da janela de contexto da missão a sessão do provedor já usou, conforme o provedor informa. Clique nele para ver os tokens usados, o tamanho da janela e o modelo. Quando o provedor não informa a janela, ou acabou de compactar o contexto, o anel fica vazio e diz o que é desconhecido. Os provedores compactam o contexto por conta própria quando ele enche.

**Recomeçar com um resumo.** A partir do popover do anel (o botão principal quando o contexto chega a 75 %), o Specrails escreve um resumo da missão: objetivo, decisões, estado atual e próximos passos. A sua próxima mensagem inicia então uma nova sessão do provedor que conhece apenas esse resumo. A conversa permanece no histórico, e uma linha recolhida **Sessão renovada · resumo** mostra o que a nova sessão sabe. Ele pede confirmação antes, e não está disponível enquanto um turno está em execução nem enquanto a missão está em Intent, que usa a própria sessão.

## Pré-requisito: o servidor MCP

O Agent Chat opera a aplicação através do **servidor MCP do Specrails** integrado, então ele precisa estar ativo. Se não estiver, o painel abre com um banner de **Ativar Specrails MCP** de um clique — pressione-o e está pronto (sem reiniciar). Veja [Controle o Specrails a partir de qualquer IA](mcp-server) para os detalhes; nada é instalado, tudo é local na sua máquina.

## Escolher sobre o que ele trabalha

O cabeçalho tem um **seletor de projeto**. Escolha um projeto e tudo o que você pedir fica restrito a ele — *«lança os de alta prioridade»* se resolve contra esse projeto. Deixe-o em **Início** e o agente trabalha sobre toda a sua configuração: ele pode listar ou criar projetos e responder perguntas que abrangem tudo. Se você pedir algo específico de um projeto estando em Início, ele vai perguntar qual (ou se oferecer para criar um) em vez de adivinhar.

Escolher um projeto aqui **não** move o seu painel — o alvo do agente e o que você está vendo são independentes.

## Níveis de permissão — a rédea está com você

O agente pode mexer na aplicação inteira, então você decide quanta liberdade ele tem por meio de um **nível** que você muda ao vivo pressionando **Shift+Tab** (o mesmo ciclo que o Claude Code usa). Cada nível inclui tudo o que está abaixo:

| Nível | O que ele pode fazer |
|---|---|
| 👀 **Observa** | Somente leitura — listar e inspecionar projetos, specs, jobs, análises. Nada muda. |
| ✍️ **Edita** | O acima **+** criar e editar (specs, ajustes, configuração de trilhos) — mudanças reversíveis. |
| ⚡ **Opera** | O acima **+** lançar trabalho de IA que **custa dinheiro** (trilhos, geração de specs). |
| 🔥 **Autônomo** | O acima **+** apagar e parar coisas — ações irreversíveis. |

Comece em **Observa** e suba o nível apenas quando quiser que o agente aja. Se ele tentar algo acima do nível atual, ele para e diz exatamente qual nível ativar — nunca contorna o limite. Isso é separado dos níveis de Ajustes ▸ MCP, que regem os assistentes *externos*; o nível aqui é só para este agente interno da aplicação.

Subir o nível **para Autônomo** nunca acontece com um só toque: Shift+Tab a partir de Opera mostra um aviso com **Mudar para Autônomo**, e um novo Shift+Tab volta para Observa. Baixar o nível é sempre imediato.

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

Os blocos de código mostram a linguagem e têm o próprio botão de **copiar**. Se você rolar para cima enquanto o agente ainda escreve, a pílula **Novas mensagens** aparece acima da caixa — clique nela para voltar à resposta mais recente.

## Detalhes práticos

- **Clique no que ele menciona.** Em uma missão fixada a um projeto, os números de spec (`#12`) e os ids de job/execução nas respostas do agente são chips clicáveis: uma spec abre o modal de detalhe do quadro e um id de job abre a visão do job ao vivo. Se a referência não existir mais, você verá um aviso discreto de "não encontrado".
- **Uma faixa para as suas execuções.** Quando o agente lança trabalho, uma única faixa logo acima da caixa de mensagem o acompanha: o que a execução está fazendo, em palavras simples ("Escrevendo a spec a partir das suas alterações"), quantas execuções terminaram, o tempo e o custo real até agora (`—` até o provedor faturar). Quando uma execução precisa de você (criar a PR, tentar de novo, voltar ao Intent), a faixa avisa com um ícone e palavras e oferece essa única ação; clique na faixa para abrir o cartão completo da execução logo acima (Esc o fecha). Com várias execuções, a faixa mostra primeiro a que precisa de você e um pequeno seletor ("Rail 1 · Rail 2 · +1"). A conversa guarda só o que aconteceu ("Iniciado em Rail 1", "Rail 1 falhou: …", "Entregue: PR #812"), e cada linha abre a sua execução. As missões que aguardam a sua decisão mostram um ponto na lista de missões. As ações que iniciam uma nova execução paga (**Relançar**, **Recuperar e tentar novamente**) ou que outras pessoas veem (Criar PR, Publicar) nunca disparam a partir da faixa: ela abre o cartão com o foco nesse botão, para que você confirme ali.
- **A faixa pelo teclado.** **⌥R** (**Alt+R** no Windows/Linux) pula da caixa de mensagem para a faixa da missão em que você está; pressione de novo para mostrar ou ocultar os detalhes da execução, e **Esc** leva você de volta para onde estava. Fora de um campo de texto, **⌥[** e **⌥]** alternam entre execuções. Com a faixa em foco, **P** pausa ou retoma um Intent e **H** o passa a um rail; essas letras não fazem nada em outro lugar. Pressione **?** para ver a lista completa.
- **Histórico de prompts.** Com a caixa vazia, pressione **↑**/**↓** para percorrer o que você perguntou antes (mostrado esmaecido enquanto rola); comece a digitar para editar, ou pressione Enter para enviar.
- **Edite a fila.** Enviou mais enquanto o agente estava ocupado? Enquanto houver mensagens na fila, **↑**/**↓** percorre *essas* mensagens: a caixa mostra a selecionada, você a edita ali mesmo e **Enter a salva de volta na fila** (Esc cancela; seu rascunho não enviado volta intacto).
- **Responda com uma tecla.** Quando o agente oferece opções, cada chip tem um número: pressione **⌥1**…**⌥9** (**Alt+1**…**Alt+9** no Windows/Linux) com a caixa vazia para escolher uma.
- **Desfaça a exclusão de uma mensagem na fila.** Ao excluir uma mensagem da fila, **Desfazer** aparece por alguns segundos e a devolve à fila.
- **Minimize sem perder nada.** Clique no ✕ para devolver o painel à bolha — a conversa continua rodando. Reabra e você chega na mensagem mais recente; nada é redigitado.
- **Nova conversa.** O botão **+** inicia um fio limpo; o histórico vive no nível da aplicação, acima de qualquer projeto individual.
- **Troque de missão e arquive.** O seletor ao lado do projeto ordena as conversas da mais recente, indica agentes trabalhando e mensagens na fila e oferece busca acima de oito missões. **Arquivar** guarda uma missão e seu histórico sem prazo; o trabalho em andamento precisa terminar primeiro. Arquivadas abrem em modo de leitura. **Restaurar** permite enviar novamente. Só uma missão arquivada oferece **Excluir**, com confirmação, para **Excluídos recentemente** por 30 dias. **Desfazer** (ou **⌘Z**) a devolve às arquivadas.

Na barra lateral Missão expandida, ao lado de **Projetos**, escolha **Ativas** (não arquivadas, padrão), **Arquivadas** ou **Todas**. O filtro vale para Favoritas, não atribuídas e cada projeto e lembra a escolha ao recarregar. Combina com o filtro de missões em andamento sem que um redefina o outro. Linhas arquivadas ficam atenuadas e marcadas em Todas.

- **Encontre uma missão de qualquer lugar.** Pressione **⌘K** (ou o botão **Pesquisar** da barra lateral no modo Agente) e digite qualquer fragmento de que se lembre — uma palavra do título *ou* do que foi dito lá dentro. As missões coincidem na hora por título a partir da memória e, um instante depois, chegam as coincidências por conteúdo com o trecho destacado, mais o projeto fixado e quando teve atividade pela última vez. No modo Agente as missões são o primeiro grupo; no quadro ficam logo depois de Projetos. Enter abre a missão.

## Cards de lançamento e cards de execução

- **O agente propõe, você aperta Play.** Peça para colocar specs em um rail ("prepara #12 e #14 em um rail") e, em vez de descrever, ele entrega um **card de lançamento**: o rail (ou um novo), as specs, engine, modelo, esforço, perfil, loop, PR de destino e branch base opcionais — tudo pré-preenchido com a recomendação dele e tudo editável. Mude o que quiser e aperte **Play**. Diga "lança agora" e ele lança direto.
- **Um único card acompanha a execução.** Depois do Play a proposta congela como "Lançado → Rail N" e um **card de execução** assume: status, tempo decorrido, o que o pipeline está fazendo, botão de log e Parar. Quando o trabalho está pronto para revisar, o mesmo card vira o card de PR de sempre (criar PR, integrar localmente, descartar).
- **Falhas falam.** Se uma execução falha ou trava, o card mostra o motivo em texto claro e oferece as opções reais — Retomar, Recuperar, Aprovar, Relançar, Descartar — e o agente publica um breve relato explicando o que aconteceu e o que recomenda. Ele nunca retoma nem relança sozinho; você decide pelo card.
- **Sem git, sem fase de PR.** Um projeto sem repositório git (ou sem commits) também recebe um card de execução — progresso, log, falha e recuperação — mas não há branch nem etapa de PR; o card avisa.
- **`@rail-N`.** Digite `@` e escolha um rail para referenciá-lo na mensagem, com suas specs e se está livre, ocupado ou aguardando decisão.

## Subagentes

Alguns provedores podem distribuir partes de uma tarefa para **subagentes**: ajudantes que trabalham em paralelo e continuam depois que o agente responde. Os subagentes vêm **ativados por padrão**; desative-os por projeto se quiser conter o custo, porque multiplicam o custo de um pedido.

- **Desative por projeto.** Abra **Configurações → Subagentes** do projeto e desative **Permitir subagentes neste projeto**. Vale para missões, exploração e refinamentos do projeto; os pipelines de Implement nunca são afetados. Missões sem projeto seguem **Configurações do app → Provedores de IA → Permitir subagentes em missões sem projeto**.
- **Escolha quem os executa.** Em **Executar subagentes com**, a opção padrão **Igual ao agente da missão** deixa o próprio CLI da missão iniciá-los nativamente: é o mais rápido, e eles compartilham o cache de prompt. Escolha um provedor, modelo e esforço para combinar provedores — por exemplo, uma missão em Codex com subagentes em Claude. Missões que já usam esse provedor continuam nativas com esse modelo; com outro provedor, o Specrails inicia cada subagente por conta própria, que começa a frio e pode custar mais, mas dá mais controle e mostra o custo real de cada um. O Specrails pede confirmação antes da troca, e esses subagentes exibem um selo do provedor na missão.
- **Acompanhe o trabalho.** Os agentes iniciados por uma resposta aparecem como uma linha compacta abaixo dela. Ela fica aberta enquanto trabalham e, quando todos terminam, se recolhe num resumo com o tempo e os tokens totais. Expanda uma linha para ler o resultado e o custo, ou acompanhar a atividade ao vivo. Cada lançamento fica no seu ponto da conversa, então os seguintes nunca se misturam com os anteriores. Pare um agente em execução pela linha dele, ou todos pela linha de resumo.
- **O agente continua sozinho.** Quando os agentes em segundo plano terminam, o agente continua e publica o que encontraram, marcado como *Continuou após os agentes em segundo plano*.
- **Mudar a configuração é seguro.** Uma missão com agentes em execução aplica a mudança quando eles terminam; ela avisa e oferece **Parar agentes e aplicar agora**.
- **Nada reinicia escondido.** Agentes interrompidos por um reinício ficam marcados como interrompidos; **Relançar** só rascunha uma mensagem pedindo ao agente que refaça esse trabalho.

## Conectores nas missões {#connectors}

As missões podem usar os conectores e servidores MCP que você já configurou em cada provedor: seus **conectores de conta do claude.ai** (Google Drive, Gmail…) e os servidores de `~/.claude.json` quando a missão usa o Claude, os servidores de `~/.codex/config.toml` no Codex e os do Gemini no Gemini. Abra **Configurações do app → Provedores de IA → Conectores nas missões** para vê-los, agrupados por provedor.

- **Tudo começa ativado.** Um conector adicionado depois também. Desative os que suas missões não precisam: cada um pode somar milhares de tokens a cada requisição.
- **Tamanhos.** **Medir tamanhos** inicia uma vez cada servidor MCP local e mostra quantas ferramentas ele tem e quantos tokens as definições ocupam, aproximadamente. O Claude envia essas definições completas em toda requisição; o Codex só as carrega quando o agente procura uma ferramenta, então no Codex um conector quase não custa nada até ser usado.
- **O MCP do Specrails nunca é carregado duas vezes.** Se a configuração de um provedor também lista o servidor do Specrails, ele aparece como sempre excluído: a missão já tem o seu.
- **Algumas linhas não podem ser alteradas.** Um servidor desativado na configuração do próprio provedor continua desativado; um adicionado por **Servidores MCP externos** segue essa configuração; o Kimi carrega seus servidores por conta própria.
- **Seus próprios servidores MCP do Claude esperam a busca de ferramentas.** As missões do Claude ainda não carregam os servidores de `~/.claude.json`: sem carregamento de ferramentas sob demanda, um servidor grande (alguns têm centenas de ferramentas) encheria o contexto. Eles serão carregados quando o Claude puder buscar ferramentas sob demanda.
- **Uma alteração vale a partir do próximo turno.** Esse turno reconstrói uma vez o cache de prompts do provedor, por isso custa um pouco mais. **Atualizar** relê as configurações dos provedores.

## Algumas coisas para saber

- **Opera e Autônomo custam dinheiro** porque executam IA. O agente destaca as ações que geram custo antes de fazê-las; mantenha o nível em Observa ou Edita se você só quer olhar e organizar.
- **O agente é de toda a aplicação**, não está atrelado ao projeto que você tem aberto — é por isso que ele tem o próprio seletor e o histórico dele não é por projeto.
- **Ele é tão capaz quanto o MCP permitir.** Se uma área inteira parecer bloqueada, verifique se o servidor MCP está ativado.
