# O tour pelo dashboard

Com um projeto adicionado, está a olhar para o seu **dashboard do projeto** — a sua base para transformar specs em código entregue. Aqui fica como se orientar.

## A visão geral

A janela tem três zonas:

- **Barra lateral esquerda** — a sua lista de projetos. Clique em qualquer projeto para mudar para ele instantaneamente; tudo o resto na janela se atualiza em conformidade. O botão **Adicionar projeto** também vive aqui.
- **Área principal** — o dashboard do projeto ativo: as suas specs e o pipeline que as executa.
- **Barra lateral direita** — a navegação entre as secções do projeto atual.

## O dashboard principal

É aqui que o trabalho acontece. O dashboard mostra:

- **As suas specs** — os tickets que criou, organizados por estado (de Backlog / Por fazer até Concluído). Pode vê-los como uma lista, uma grelha ou cartões tipo post-it, conforme preferir.
- **Uma forma de adicionar uma spec** — comece um novo trabalho. Pode escrever uma spec rápida diretamente, ou abrir um chat **Explorar** guiado que o ajuda a moldá-la através de conversa e redige o ticket por si.
- **Rails** — estas são as pistas onde as specs são construídas. Largue uma spec num rail e lance-o para a enviar pelo pipeline Arquiteto → Developer → Revisor → Ship. Vários rails podem correr ao mesmo tempo, por isso pode trabalhar em várias coisas em paralelo.

Quando uma spec está em execução, vai ver o progresso do seu pipeline e os logs em direto — a saída em tempo real da IA enquanto desenha, programa e revê a sua alteração.

## A barra lateral direita: secções do projeto

A barra lateral direita é o seu painel de comutação para o projeto atual. Passe o rato por cima para a expandir, ou afixe-a aberta. As secções que vai encontrar:

- **Dashboard** — o quadro de specs e os rails (onde estava agora mesmo).
- **Jobs** — todas as execuções do pipeline deste projeto, passadas e presentes, com estado, duração e a possibilidade de aprofundar o detalhe e os logs de qualquer execução.
- **Integrações** — extras opcionais, como ligar as suas specs a um quadro do **Jira** ou ativar ferramentas adicionais para a IA.
- **Definições** — opções por projeto (telemetria, orçamentos, configuração de fornecedores e muito mais).

## A barra de estado

Uma faixa fina percorre o fundo da janela. É pequena, mas prática:

- **Indicador de ligação** (à esquerda) — um ponto colorido e uma etiqueta a mostrar que a app está ativa: verde para *ligado*, âmbar enquanto *reconecta*, azul enquanto *sincroniza* logo após uma reconexão. Raramente vai precisar dele, mas é tranquilizador quando precisa.
- **Gasto total** (à direita) — um total acumulado do que gastou, para que o custo esteja sempre a um relance de distância.
- **Botão do terminal** (à direita ao fundo) — abre o painel de terminal integrado. Carregue em **Cmd+J** (macOS) ou **Ctrl+J** (Windows/Linux) para o alternar a qualquer momento. É uma shell completa, aberta diretamente na pasta do seu projeto.

## Alguns atalhos úteis {#shortcuts}

- **Cmd/Ctrl+B** — afixar ou recolher a barra lateral esquerda; **Option+Cmd+B** (**Ctrl+Alt+B**) faz o mesmo com a direita.
- **Cmd/Ctrl+J** — alternar o painel de terminal.
- **Cmd/Ctrl+K** — a paleta de comandos: pesquise missões, projetos e jobs e **execute ações**. Digite um verbo ("nova", "lançar", "mover", "trocar") ou comece com **>** para listar ações: Nova spec (também em Explorar), Lançar ou Mover uma spec, Abrir sua revisão, Entregar ou Pausar um Flow, Nova missão, Trocar tema, Alternar entre os modos Missão e Quadro, Abrir as configurações do app ou do projeto em uma seção, Executar um loop, alternar as barras laterais, Voltar ou Avançar, Desfazer a última alteração e Excluídos recentemente. Ações que precisam de uma escolha (um rail, um status, um tema, uma seção) abrem uma segunda página; **Backspace** com a pesquisa vazia volta. Cada ação mostra seu atalho de teclado, então a paleta ensina as teclas. Ela só oferece o que funciona onde você está e segue as mesmas regras dos botões (uma spec que não pode ser lançada não é oferecida). Com a pesquisa vazia, lista suas **Ações recentes** e **Lugares recentes**.
- **Cmd+[ / Cmd+]** (**Alt+← / Alt+→** no Windows/Linux), os botões **←  →** da barra de título ou os botões voltar/avançar do mouse — voltam ou avançam pelos lugares onde você esteve: specs, missões, jobs, projetos e painéis em tela cheia. Clique com o botão direito (ou pressione e segure) um botão para ver os últimos lugares.
- **Cmd+Shift+I** (**Ctrl+Alt+I** no Windows e no Linux) ou o botão **Pendências** na barra de título — a lista **Pendências**: tudo o que espera por você em todos os seus projetos, numa só lista agrupada por projeto. Reúne revisões prontas para decidir, perguntas que um agente está aguardando, execuções que falharam ou ficaram bloqueadas, execuções pausadas pelo orçamento diário e atualizações do Jira que não puderam sincronizar. Cada linha tem a ação principal ali mesmo (**Abrir revisão**, **Responder**, **Retomar**, **Tentar novamente**) mais **Adiar** (1 hora ou até amanhã) e **Concluído**. Um item adiado ou concluído volta sozinho se o estado dele mudar. O botão mostra quantos itens aguardam e uma notificação de limite do provedor abre a lista. A lista também é um link (`?inbox=1`) e uma ação da paleta de comandos.
- **M** — com um cartão de spec em foco no quadro, abre um seletor para o mover para um estado ou um rail, o equivalente de arrastar e largar com o teclado. Funciona também com uma seleção múltipla, e a paleta oferece-o como **Mover a spec em foco…**.
- **?** — a folha de atalhos. Digite na caixa de pesquisa para filtrar os atalhos e encontrar páginas e seções deste guia, que abrem no guia sem sair da sua tela. Os pequenos ícones **ⓘ** e os links **Saiba mais** ao lado das configurações, dos rails, do Flow, do seletor de contexto e dos orçamentos abrem o guia na seção correspondente do mesmo modo.

## Para onde ir a seguir

E aqui está a vista de conjunto. A partir daqui, o passo natural é **adicionar uma spec** e lançá-la num rail — veja o pipeline correr de ponta a ponta e, depois, consulte **Analytics** para ver quanto custou. Bem-vindo a bordo.
