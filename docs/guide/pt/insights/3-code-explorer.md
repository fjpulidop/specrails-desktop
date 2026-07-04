# Code explorer

A secção **Code** dá-lhe uma janela amigável e só de leitura para o seu repositório — pensada especialmente para quem quer perceber o que a IA tem andado a construir sem viver dentro de um editor. Tem uma árvore de ficheiros à esquerda, um visualizador de código à direita e, por cima do código, um resumo em linguagem simples do que cada ficheiro faz na prática.

Nesta versão é estritamente só de leitura: nada do que faz aqui altera os seus ficheiros. Pense nisto como uma sala de leitura, não uma oficina.

Abra-a a partir da barra lateral direita (**Code**) e, como tudo o resto, diz respeito ao seu projeto atual.

## A árvore de ficheiros

O painel da esquerda é uma árvore virtualizada dos ficheiros do seu projeto — rápida mesmo em repositórios grandes. Respeita o seu `.gitignore` e uma lista de exclusão incorporada, por isso vê os ficheiros que interessam, e não um mar de artefactos de build e `node_modules`.

Junto aos ficheiros vai reparar em **etiquetas de proveniência** — pequenos marcadores que lhe dizem que um ficheiro foi *alterado por IA*. É este o coração do Code explorer: o Specrails regista que ficheiros cada job de pipeline criou ou modificou, e liga-os de volta ao ticket que motivou o trabalho. Assim consegue responder, num relance, a "foi a IA que escreveu isto, ou fui eu?".

No topo da árvore há um filtro:

- **Alterados por IA** (a predefinição) — apenas os ficheiros que a IA alterou.
- **Todos os ficheiros** — a árvore completa.

A sua escolha fica memorizada por projeto, por isso, se o que mais lhe importa são as alterações feitas pela IA, vai vê-las em primeiro lugar de cada vez.

## O visualizador de código

Clique num ficheiro e ele abre num visualizador completo (com o Monaco, o mesmo motor do VS Code), com realce de sintaxe adequado e a condizer com o tema que escolheu para a aplicação. Alguns limites sensatos mantêm tudo fluido: os ficheiros binários são recusados com delicadeza e os ficheiros muito grandes (acima de 2 MB) não carregam.

O ficheiro atual fica guardado no URL da página, para poder marcar nos favoritos ou partilhar uma ligação diretamente para um ficheiro específico.

Como a edição não faz parte desta versão, o visualizador oferece um botão **Editar num editor externo** que copia o caminho absoluto do ficheiro — cole-o no editor da sua preferência e continue a partir daí.

## Resumos por IA

Por cima do código vê um **resumo em linguagem simples** do ficheiro — para que serve, o que faz — escrito de forma a que uma pessoa não programadora consiga acompanhar. São gerados por si e ficam em cache, por isso abrir um ficheiro que já tinha visto antes é instantâneo.

Os resumos são espertos a manter-se atualizados: estão associados ao conteúdo do ficheiro, por isso, quando um ficheiro muda de verdade, o resumo é regenerado, mas os ficheiros inalterados não são resumidos de novo sem necessidade. Se for você a editar um ficheiro, o seu resumo é marcado como desatualizado em vez de ser regenerado em silêncio — fica no controlo de quando é atualizado. Há uma ação de **regenerar** para quando quiser uma nova versão a pedido.

Algumas salvaguardas mantêm os custos sob controlo: a geração de resumos corre dentro de um **orçamento mensal** (alguns dólares por predefinição, configurável nas Definições) e há limites para quantos resumos um único job pode despoletar. Se um resumo for ignorado, a aplicação diz-lhe porquê — orçamento atingido, um limite por job, ou simplesmente o ficheiro não ter sido encontrado.

Pode também escolher o **idioma do resumo** (inglês ou espanhol) nas definições globais, na área da *secção Code*.

## A história de construção

Por baixo do visualizador de código vive a **história de construção** — uma linha do tempo cronológica de cada spec e cada job que construíram o ficheiro que estás a ver. Cada capítulo é um cartão: que spec interveio (com o seu estado atual), quando, se o ficheiro foi criado, modificado ou eliminado, e o tamanho da mudança (linhas adicionadas e removidas). Clica num cartão para abrir o detalhe dessa spec. Os rails baseados em loops também registam os ficheiros que tocam, por isso o trabalho feito em worktrees isolados aparece na história tal como os jobs normais do pipeline.

Para qualquer capítulo podes pedir uma explicação em linguagem simples: carrega em **Explicar esta alteração** e a app escreve uma a três frases a descrever o que essa mudança concreta contribuiu para o ficheiro — sem código, sem jargão. As explicações partilham o mesmo orçamento mensal dos resumos de ficheiros e, enquanto nenhuma for gerada, o cartão recorre aos factos que conhece: o tipo de mudança, a spec e a data. Preferes os dados em bruto? Um seletor **História / Registro** muda para a lista clássica de alterações com diffs a pedido. O mesmo painel aparece na vista **Files** do modo Agente.

## Ligar o código de volta às specs

A ligação de proveniência funciona nos dois sentidos. Dentro do Code explorer, clicar na etiqueta de um ticket num ficheiro abre o detalhe desse ticket. E no sentido inverso, a vista de **detalhe do ticket** tem uma secção *Ficheiros alterados por este ticket* — clique aí num ficheiro e salta diretamente para o Code explorer com ele aberto. Fecha o ciclo entre "aqui está a spec que escrevemos" e "aqui está o código que daí saiu".

## O que (ainda) não faz

Para deixar as expectativas claras, esta primeira versão deixa de fora, de propósito, algumas coisas: edição dentro da aplicação, resumos ao nível do símbolo ou da pasta, uma vista de diff narrativa e o "pergunte à IA sobre este ficheiro" em modo de conversa. A proveniência atribui um ficheiro apenas ao seu ticket principal. São o tipo de coisas que podem crescer com o tempo.

## Desligá-lo

O Code explorer está ligado por predefinição. Pode ser desativado com as flags `VITE_FEATURE_CODE_EXPLORER` (cliente) ou `SPECRAILS_CODE_EXPLORER` (servidor) — defina qualquer uma como `false`. Desligá-lo deixa todos os seus dados registados e resumos em segurança no disco, intactos, para o caso de o voltar a ligar.
