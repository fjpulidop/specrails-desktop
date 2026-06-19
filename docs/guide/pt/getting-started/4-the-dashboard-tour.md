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
- **Analytics** — quanto lhe está a custar a utilização de IA. Gastos divididos por dia, por atividade, por modelo e por ticket — para que não haja surpresas.
- **Agentes** — os perfis de agentes do seu projeto: que agentes correm no pipeline e que modelos de IA usam. *(Apenas projetos com Claude.)*
- **Code** — um explorador de ficheiros só de leitura com resumos de IA em linguagem simples, e etiquetas a mostrar que ficheiros a IA tocou. Ótimo para quem não programa mas quer acompanhar.
- **Integrações** — extras opcionais, como ligar as suas specs a um quadro do **Jira** ou ativar ferramentas adicionais para a IA.
- **Definições** — opções por projeto (telemetria, orçamentos, configuração de fornecedores e muito mais).

> Algumas secções só aparecem quando fazem sentido para os fornecedores que escolheu — por exemplo, **Agentes** é específico do Claude. Se não vir uma secção, é simplesmente porque não se aplica à configuração deste projeto.

## A barra de estado

Uma faixa fina percorre o fundo da janela. É pequena, mas prática:

- **Indicador de ligação** (à esquerda) — um ponto colorido e uma etiqueta a mostrar que a app está ativa: verde para *ligado*, âmbar enquanto *reconecta*, azul enquanto *sincroniza* logo após uma reconexão. Raramente vai precisar dele, mas é tranquilizador quando precisa.
- **Gasto total** (à direita) — um total acumulado do que gastou, para que o custo esteja sempre a um relance de distância.
- **Botão do terminal** (à direita ao fundo) — abre o painel de terminal integrado. Carregue em **Cmd+J** (macOS) ou **Ctrl+J** (Windows/Linux) para o alternar a qualquer momento. É uma shell completa, aberta diretamente na pasta do seu projeto.

## Alguns atalhos úteis

- **Cmd/Ctrl+B** — afixar ou recolher as barras laterais.
- **Cmd/Ctrl+J** — alternar o painel de terminal.
- **Cmd/Ctrl+K** — abrir a pesquisa.

## Para onde ir a seguir

E aqui está a vista de conjunto. A partir daqui, o passo natural é **adicionar uma spec** e lançá-la num rail — veja o pipeline correr de ponta a ponta e, depois, consulte **Analytics** para ver quanto custou. Bem-vindo a bordo.
