# O tour pelo dashboard

Com um projeto adicionado, está a olhar para o seu **dashboard do projeto** — a sua base para transformar specs em código entregue. Aqui fica como se orientar.

## A visão geral

A janela tem três zonas:

- **Barra lateral esquerda** — a sua lista de projetos. Clique em qualquer projeto para mudar para ele instantaneamente; tudo o resto na janela se atualiza em conformidade. O botão **Adicionar projeto** também vive aqui.
- **Área principal** — o dashboard do projeto ativo: as suas specs e o pipeline que as executa.
- **Barra lateral direita** — a navegação entre as secções do projeto atual.

## O dashboard principal

É aqui que o trabalho acontece. O dashboard mostra:

- **As suas specs** — as specs que criou, organizadas por estado (de Backlog / Por fazer até Concluído). Pode vê-las como uma lista, uma grelha ou cartões tipo post-it, conforme preferir.
- **Uma forma de adicionar uma spec** — comece um novo trabalho. Pode escrever uma spec rápida diretamente, ou abrir um chat **Explorar** guiado que o ajuda a moldá-la através de conversa e redige a spec por si.
- **Rails** — estas são as pistas onde as specs são construídas. Largue uma spec num rail e lance-o para a enviar pelo pipeline Arquiteto → Developer → Revisor → Ship. Vários rails podem correr ao mesmo tempo, por isso pode trabalhar em várias coisas em paralelo.

Quando uma spec está em execução, vai ver o progresso do seu pipeline e os logs em direto — a saída em tempo real da IA enquanto desenha, programa e revê a sua alteração.

## A barra lateral direita: secções do projeto

A barra lateral direita é o seu painel de comutação para o projeto atual. Passe o rato por cima para a expandir, ou afixe-a aberta. As secções que vai encontrar:

- **Dashboard** — o quadro de specs e os rails (onde estava agora mesmo).
- **Jobs** — todas as execuções do pipeline deste projeto, passadas e presentes, com estado, duração e a possibilidade de aprofundar o detalhe e os logs de qualquer execução.
- **Integrações** — extras opcionais, como ligar as suas specs a um quadro do **Jira** ou ativar ferramentas adicionais para a IA.
- **Definições** — opções por projeto (telemetria, orçamentos, configuração de fornecedores e muito mais).

## A barra de estado

Uma faixa fina percorre o fundo da janela. É igual nos modos Missão e Quadro, e mantém-se discreta: quando não há nada a dizer, um espaço fica simplesmente vazio.

- **Ligação** (à esquerda) — vazia enquanto está tudo bem. Mostra *A religar…* (âmbar) ou *Sem ligação* (vermelho) apenas quando a app perde o seu servidor local, e *A sincronizar…* durante um momento depois de voltar a ligar.
- **Atualizar** (à direita) — aparece quando uma nova versão está pronta e a app está inativa há cerca de meio minuto. Clique para abrir o cartão de atualização (consulte [Atualizações](../settings/6-updates.md)).
- **Uso do plano** (à direita) — um único medidor para o fornecedor mais perto do seu limite. Fica neutro até aos 80 %, passa a âmbar com o nome do fornecedor a partir dos 80 % e a vermelho a partir dos 90 %, e mostra *limite · repõe 15:00* quando o fornecedor recusa pedidos. Passe o rato por cima ou clique para ver as janelas de cada fornecedor e o gasto de hoje neste projeto.
- **Recursos da app** (à direita) — um ícone e o número de processos, só enquanto há trabalho a correr. Clique para ver o CPU e a memória, uma tendência da memória e a divisão por origem: missões e chats, rails, loops e jobs, processos em segundo plano, terminais, CLIs de agentes, MCP e runners, Git e o próprio servidor do Specrails. Expanda uma origem para ver os seus processos. Abaixo das origens, **Portas dos worktrees de execução** lista as portas servidas pelo servidor de desenvolvimento ou de testes de cada rail (rail, spec, projeto e processo) e avisa quando outro processo ocupa as portas atribuídas a um rail. Na app para desktop, **Manter o computador ativo** também está aqui; enquanto estiver ligado, um ícone de chávena na barra de estado indica-o (clique nele para voltar a permitir a suspensão).
- **Botão do terminal** (à direita ao fundo) — abre o painel de terminal integrado. Carregue em **Cmd+J** (macOS) ou **Ctrl+J** (Windows/Linux) para o alternar a qualquer momento. É uma shell completa, aberta diretamente na pasta do seu projeto.

## Janelas próprias

Na app de desktop, alguns ecrãs abrem como janelas reais em vez de painéis dentro da janela principal: **Definições**, o detalhe de um job aberto a partir de uma missão, e **Loops** e **Plugins** no modo Missão. Pode movê-las para outro ecrã e continuar a trabalhar na janela principal. Cada uma usa os controlos de janela do próprio sistema; as Definições e a janela do job também fecham com **Escape**. As alterações que fizer aí, como o tema ou o idioma, aplicam-se de imediato à janela principal. Na versão de browser, estes ecrãs abrem como painéis.

## Notificações do que precisa de você {#attention}

O Specrails avisa quando algo precisa de você: uma pergunta ou a resposta de uma missão, uma revisão pronta para decidir, uma execução que falhou, foi bloqueada ou parou de avançar, um limite de gasto e um job concluído. A forma depende de onde você está:

- **Fora do app** — uma notificação do sistema com o projeto e a causa. No app para desktop ela não pode ser clicada; quando você volta, um aviso resume (**3 coisas precisam de você**) e abre o item, ou **Pendências** quando são vários. Os avisos que chegam enquanto **Continue de onde parou** ou o tour da plataforma estão abertos esperam até você fechá-los e depois chegam como um só.
- **Em outra parte do app** — um pequeno aviso com **Abrir**.
- **Já está vendo** — nada. Uma missão que você está acompanhando não avisa das próprias respostas; uma execução travada é a exceção e sempre avisa.

Cada novo estado de um item é anunciado uma vez; depois de reiniciar, nada antigo é anunciado de novo. Na caixa de entrada, itens que você ainda não viu têm um ponto; **Marcar como não lido** e **Marcar como lido** mudam isso. No app para desktop, o ícone do Dock (o lançador no Linux) mostra quantos itens você não viu.

Escolha do que ser avisado em **Configurações ▸ Notificações**: desative tudo, escolha as categorias (perguntas e respostas, revisões, falhas, limites de gasto, jobs concluídos), adicione um som, oculte o selo do Dock ou desative um projeto. O sino ao lado do nome de um projeto na caixa de entrada também o silencia; os itens dele continuam na caixa de entrada.

## O quadro ao vivo {#live-board}

O **quadro ao vivo** mostra num só lugar todas as execuções de todos os seus projetos: rails, loops, sessões de Intent e jobs. Abra-o em **Quadro ao vivo** na barra lateral esquerda, com **Cmd+Shift+B** (**Ctrl+Shift+B** no Windows e no Linux) ou com **Abrir quadro ao vivo** na paleta de comandos. Ele também é um link (`?live=1`), então **Voltar** o fecha.

Escolha como lê-lo com o seletor no cabeçalho (sua escolha fica salva):

- **Por estado**: quatro colunas. **Precisa de você** é exatamente o que a caixa de entrada lista (perguntas, falhas, execuções bloqueadas, limites de gasto, atualizações do Jira), do mais antigo para o mais novo. **Em andamento** reúne o que está rodando e depois o que espera na fila. **Para decidir** reúne o trabalho pronto para sua revisão. **Concluído hoje** reúne o que terminou, foi mesclado ou parado hoje, e se esvazia à meia-noite. Uma execução fica sempre em uma única coluna.
- **Por missão**: uma linha por missão com todas as execuções que ela iniciou, seu projeto, motor, número de execuções e o gasto de hoje. As missões que precisam de você vêm primeiro; as execuções que nenhuma missão iniciou fecham a lista em **Fora de uma missão**.

Cada cartão mostra o estado da execução, o projeto, o rail ou o tipo, o título, o que ela está fazendo agora, suas etapas quando existem, o motor, há quanto tempo roda ou espera e o custo quando conhecido. Uma pergunta mostra seu texto. O botão do cartão é a mesma ação do resto do app: **Responder**, **Abrir revisão**, **Retomar**, **Tentar novamente**, **Aumentar limite** ou **Abrir**, que abre a missão que iniciou a execução ou a própria execução. Filtre por projeto, por tipo (Rails, Loops, Intent, Jobs) ou por motor; o cabeçalho resume quantas precisam de você, quantas estão em andamento e quanto você gastou hoje.

No app para desktop, o quadro sempre abre numa janela própria, para uma segunda tela: qualquer forma de abri-lo traz essa janela para a frente, e **Cmd+Shift+B** a mostra ou oculta. Os botões dele agem na janela principal, que vem para a frente.

## Alguns atalhos úteis {#shortcuts}

- **Cmd/Ctrl+B** — afixar ou recolher a barra lateral esquerda; **Option+Cmd+B** (**Ctrl+Alt+B**) faz o mesmo com a direita.
- **Cmd/Ctrl+J** — alternar o painel de terminal.
- **Cmd/Ctrl+K** — a paleta de comandos: pesquise missões, projetos e jobs e **execute ações**. Digite um verbo ("nova", "lançar", "mover", "trocar") ou comece com **>** para listar ações: Nova spec (também em Explorar), Lançar ou Mover uma spec, Abrir sua revisão, Entregar ou Pausar um Intent, Nova missão, Trocar tema, Alternar entre os modos Missão e Quadro, Abrir as configurações do app ou do projeto em uma seção, Executar um loop, alternar as barras laterais, Voltar ou Avançar, Desfazer a última alteração e Excluídos recentemente. Ações que precisam de uma escolha (um rail, um status, um tema, uma seção) abrem uma segunda página; **Backspace** com a pesquisa vazia volta. Cada ação mostra seu atalho de teclado, então a paleta ensina as teclas. Ela só oferece o que funciona onde você está e segue as mesmas regras dos botões (uma spec que não pode ser lançada não é oferecida). Com a pesquisa vazia, lista suas **Ações recentes** e **Lugares recentes**.
- **Cmd+[ / Cmd+]** (**Alt+← / Alt+→** no Windows/Linux), os botões **←  →** da barra de título ou os botões voltar/avançar do mouse — voltam ou avançam pelos lugares onde você esteve: specs, missões, jobs, projetos e painéis em tela cheia. Clique com o botão direito (ou pressione e segure) um botão para ver os últimos lugares.
- **Cmd+Shift+I** (**Ctrl+Alt+I** no Windows e no Linux) ou o botão **Pendências** na barra de título — a lista **Pendências**: tudo o que espera por você em todos os seus projetos, numa só lista agrupada por projeto. Reúne revisões prontas para decidir, perguntas que um agente está aguardando, execuções que falharam ou ficaram bloqueadas, execuções pausadas pelo orçamento diário e atualizações do Jira que não puderam sincronizar. Cada linha tem a ação principal ali mesmo (**Abrir revisão**, **Responder**, **Retomar**, **Tentar novamente**) mais **Adiar** (1 hora ou até amanhã) e **Concluído**. Um item adiado ou concluído volta sozinho se o estado dele mudar. O botão mostra quantos itens aguardam e uma notificação de limite do provedor abre a lista. A lista também é um link (`?inbox=1`) e uma ação da paleta de comandos.
- **M** — com um cartão de spec em foco no quadro, abre um seletor para o mover para um estado ou um rail, o equivalente de arrastar e largar com o teclado. Funciona também com uma seleção múltipla, e a paleta oferece-o como **Mover a spec em foco…**.
- **?** — a folha de atalhos. Digite na caixa de pesquisa para filtrar os atalhos e encontrar páginas e seções deste guia, que abrem no guia sem sair da sua tela. Os pequenos ícones **ⓘ** e os links **Saiba mais** ao lado das configurações, dos rails, do Intent, do seletor de contexto e dos orçamentos abrem o guia na seção correspondente do mesmo modo.

## Para onde ir a seguir

E aqui está a vista de conjunto. A partir daqui, o passo natural é **adicionar uma spec** e lançá-la num rail — veja o pipeline correr de ponta a ponta e, depois, consulte **Analytics** para ver quanto custou. Bem-vindo a bordo.
