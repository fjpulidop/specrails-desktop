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
- **Analytics** — invocações por dia, atividade, modelo e ticket. Claude comunica custo faturado, Codex/Gemini usam estimativas e Kimi deixa vazios os campos de tokens/custo USD indisponíveis.
- **Agentes** — perfis e catálogos de roles por provider para Claude e Kimi. Com Kimi, os roles são criados/editados manualmente; Generate, Test e AI Refine não estão disponíveis.
- **Code** — um explorador de ficheiros só de leitura com etiquetas dos ficheiros tocados pela IA. Os resumos em linguagem simples só aparecem com providers compatíveis e não estão disponíveis com Kimi.
- **Integrações** — extras opcionais, como ligar as suas specs a um quadro do **Jira** ou ativar ferramentas adicionais para a IA.
- **Definições** — opções por projeto (telemetria, orçamentos, configuração de fornecedores e muito mais).

> Secções e ações seguem as capacidades do provider efetivo. Por exemplo, os perfis funcionam com Claude e Kimi, mas as ações de IA do Agent Studio falham de forma fechada com Kimi.

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
