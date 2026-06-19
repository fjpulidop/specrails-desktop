# Rascunhos e o Contract Layer

Esta página cobre duas formas de tirar mais partido das suas specs: os **rascunhos** (guardar uma ideia em curso para a retomar mais tarde) e o **Contract Layer** (um enriquecimento opcional que torna as specs mais precisas para o pipeline de IA).

## Rascunhos: guardar uma ideia em curso

Um **rascunho** é uma conversa de [Explore](add-spec-explore-mode.md) em curso guardada como spec. Permite-lhe parar a meio de um pensamento sem perder nada e voltar quando estiver pronto.

### Guardar um rascunho

Enquanto está numa conversa de Explore, clique em **Guardar como rascunho** (disponível assim que tiver enviado pelo menos uma mensagem). A app:

- Cria uma spec com estado **Rascunho** no seu quadro.
- Dá-lhe um título automaticamente se não tiver definido nenhum (um resumo curto da conversa).
- Liga-a de volta à conversa, para que todo o histórico de chat seja preservado.

Guardar é idempotente — se guardar a mesma conversa duas vezes, atualiza o rascunho existente em vez de criar um duplicado.

### Como os rascunhos aparecem no quadro

Os rascunhos vivem no mesmo grupo ativo que as suas specs Por fazer — não há uma coluna separada. Vai identificá-los por:

- Uma etiqueta `Draft` onde normalmente fica a etiqueta de prioridade.
- Um contorno subtilmente colorido no cartão.

Um rascunho pode *não ter prioridade* — a prioridade é definida quando o confirma numa spec a sério.

### Retomar um rascunho

Para continuar de onde ficou:

1. Abra o rascunho a partir do quadro.
2. Clique em **Continuar a editar** na janela de detalhe.
3. A conversa de Explore original reabre-se com todo o seu histórico de chat, e o painel do rascunho ao vivo pré-preenchido com tudo o que já tinha moldado.
4. Continue a conversar. Quando terminar, **Criar Spec** promove o rascunho a uma spec a sério (estado **Por fazer**, com a prioridade que escolher).

### Descartar um rascunho

Os rascunhos **nunca são eliminados automaticamente**. Só desaparecem quando os descarta explicitamente, ou quando os confirma num estado a sério. Descartar um rascunho também limpa a conversa associada quando mais nada a referencia.

> Dica: quando não tiver a certeza se uma spec vale a pena, guarde-a como rascunho e deixe-a repousar. Abra-a na manhã seguinte, dê uma olhadela à descrição, e decida com olhos descansados.

## O Contract Layer: precisão para o pipeline

O **Contract Layer** é um enriquecimento opcional que acrescenta um bloco estruturado à descrição de uma spec. A sua função é eliminar a adivinhação para os agentes de IA que implementam a spec — para que reutilizem os nomes certos, respeitem os formatos de dados esperados e mexam nos ficheiros certos, em vez de inventarem os seus próprios.

### O que adiciona

O Contract Layer são cinco secções curtas acrescentadas à spec:

- **Naming Contract** — os identificadores exatos (funções, campos, rotas) que a implementação deve reutilizar.
- **Data Shapes** — os payloads, em formato semelhante a JSON, envolvidos.
- **State Machine** — as transições ou estados pelos quais a funcionalidade passa.
- **Invariants** — propriedades que devem ser sempre verdadeiras.
- **File Touch List** — os ficheiros que a implementação deverá editar.

Pense nisto como entregar ao pipeline uma planta precisa em vez de um esboço. É especialmente valioso para specs que se ligam a código existente, onde a IA, ao adivinhar um nome ou um formato, causaria retrabalho.

### Como adicioná-lo

Há três formas de aplicar o Contract Layer:

- **Modo Quick** — ative o interruptor **Enriquecer com Contract Layer** antes de gerar. A sua última escolha é memorizada por projeto. (Veja [Adicionar Spec — modo Quick](add-spec-quick-mode.md).)
- **Modo Explore** — escolha o preset de contexto **Máx** ou **Desktop** (que correm o enriquecimento automaticamente na confirmação), ou abra **Ajuste fino** e ative-o manualmente. (Veja [Adicionar Spec — modo Explore](add-spec-explore-mode.md).)
- **Numa spec existente** — abra a janela de detalhe da spec e volte a correr o enriquecimento a partir daí.

### Onde aparece

Depois de uma spec ter um Contract Layer, a janela de detalhe mostra-o como um bloco colapsável com um distintivo do tipo `3/5 preenchidas` — dizendo-lhe quantas das cinco secções foram efetivamente preenchidas (algumas funcionalidades simplesmente não têm, por exemplo, uma state machine, e essas secções ficam marcadas como não aplicáveis). Expanda-o para ler o contrato completo; recolha-o para manter a descrição arrumada.

Se o enriquecimento alguma vez falhar ao correr, a app apresenta uma notificação com uma ação **Repetir** para que o possa disparar de novo.

### Vale sempre a pena?

Nem sempre. Para uma spec pequena e autocontida, a IA consegue implementá-la bem sem ele. O Contract Layer ganha o seu valor em specs que se integram fortemente com código existente, onde os nomes e formatos exatos importam — é aí que fixar o contrato à partida lhe poupa uma ronda de correções mais tarde.

## Para onde ir a seguir

- [Adicionar Spec — modo Explore](add-spec-explore-mode.md) — de onde vêm os rascunhos.
- [Adicionar Spec — modo Quick](add-spec-quick-mode.md) — o interruptor do Contract Layer no modo Quick.
- [Executar pipelines](running-pipelines.md) — implemente uma spec assim que estiver pronta.
