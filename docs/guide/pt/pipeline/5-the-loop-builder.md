# O Loop Builder

Um **rail roda um Loop**. Os loops embutidos (`Implement`, `Batch`, `Freestyle`) cobrem os casos do dia a dia, mas o **Loop Builder** deixa você desenhar os seus próprios — um editor visual, no estilo n8n, para automação que se repete até atingir uma meta. Esta página explica o que é um loop, como construir um e como rodá-lo em um rail.

## Loops e rails — a relação

Um **loop** é a *receita* do trabalho; um **rail** é a *pista* que o roda contra as suas specs.

```
   Loop Builder (barra lateral esq.)        Rails (direita)
   ───────────────────────────             ─────────────
   Implement   (embutido)                  Rail 1
   Batch       (embutido)      escolha ►      Loop: Verify-until-green
   Freestyle   (embutido)                     ▶ Play
   Verify-until-green (seu)
```

- Os loops vivem na seção **Loops** (barra lateral esquerda, ao lado dos seus projetos) — eles são **globais**, compartilhados por todos os projetos.
- Um rail **escolhe um loop** no cabeçalho (o seletor de Loop) e o roda quando você aperta Play.
- O **rail** decide o provedor, o modelo e o esforço de raciocínio — *não* os passos do loop. O mesmo loop roda em Claude, Codex ou Gemini dependendo do rail.

Ou seja: construa um loop uma vez e depois escolha-o em qualquer rail, em qualquer projeto.

## Abrindo o builder

Clique em **Loops** na barra lateral esquerda para ver a biblioteca: os três loops embutidos mais os seus próprios. Abra um para vê-lo, ou clique em **New loop** para começar de uma tela em branco.

Você não consegue editar um embutido diretamente com facilidade — em vez disso, faça **Fork** dele. Isso te dá uma cópia editável de um grafo que funciona como ponto de partida, que é a forma mais fácil de aprender.

## Do que um loop é feito

Um loop é um grafo de **nós** conectados por **arestas** (as setas). Cada nó é um passo:

| Nó | O que faz |
|------|--------------|
| **Start** | Onde a execução começa. Exatamente um por loop. |
| **AI Step** | Roda um turno de IA — um prompt que você escreve, ou um *comando mágico* como `{{cmd:implement}}`, `{{cmd:verify}}`, `{{cmd:fix}}`. É aqui que o trabalho de verdade acontece. |
| **Shell** | Roda um comando de shell (ex.: `npm test`) e captura sua saída para passos posteriores. |
| **Loop Decider** | O cérebro de um loop. A cada passagem ele lê uma **meta** que você escreve e decide **continue** (voltar e tentar de novo) ou **stop** (sair). É isto que faz funcionar o *verify → fix → verify até ficar verde*. |
| **End** | Um nó terminal. Marca a execução como sucesso ou falha. |

As arestas conectam os passos em ordem. O **Loop Decider** tem duas saídas rotuladas — **continue** e **stop** — então você liga o "ainda não terminei" de volta ao trabalho e o "terminei" para um End.

### Escrevendo o texto dos passos

Dentro de qualquer AI Step ou Decider você pode referenciar:

- **Dados da spec** — `{{spec.title}}`, `{{spec.description}}`, `{{spec.ids}}` (os IDs dos tickets do rail). Preenchidos a partir da(s) spec(s) do rail em tempo de execução.
- **Comandos mágicos** — `{{cmd:implement}}` e seus companheiros expandem para o comando de pipeline correspondente.
- **Constantes** — `{{const:NAME}}` puxa da **biblioteca de constantes** global (arraste-as da paleta). Sentinelas embutidos como os marcadores de PASS/FAIL da verificação estão sempre disponíveis; você pode adicionar os seus e reutilizá-los em todos os loops.

## Mantendo um loop limitado

Um loop que nunca para queimaria dinheiro para sempre, então toda execução tem três proteções (definidas na barra de ferramentas do builder):

| Proteção | O que faz |
|-------|--------------|
| **Max iterations** | Teto rígido de quantas vezes o Decider pode voltar atrás, independentemente do seu veredito. |
| **Timeout (min)** | Limite de tempo de relógio para toda a execução. |
| **Max cost ($)** | *Opcional.* Para o loop quando o custo acumulado cruza o seu orçamento. Verificado **entre passos** (o custo de um passo só é conhecido quando ele termina), então pode freestylepassar em um passo. No Claude o custo é exato; no Codex e no Gemini é uma estimativa. Deixe vazio para não ter teto. |

## Construindo com confiança

O builder ajuda você a acertar um loop antes mesmo de ele rodar:

- **Validação ao vivo** — problemas (sem Start, um passo órfão, um prompt vazio, um Decider com ramos faltando) são sinalizados na tela e em um painel de problemas.
- **Pré-visualização de dry-run** — resolve o texto exato de cada passo (dados da spec, constantes e comandos todos expandidos) **sem spawnar nada**, para você ver com precisão o que cada passo enviaria.
- **Auto-arrange** — organize a tela na vertical, na horizontal ou em grade; sua escolha é salva por loop.
- **Copiar / colar** — `Cmd/Ctrl + C` / `V` para copiar passos dentro de um loop ou entre loops.
- **Importar / exportar** — salve loops em um arquivo `.json` e importe-os de volta (nomes duplicados são ignorados, o resto é importado).
- **Renomear passos** — dê a cada nó um rótulo personalizado para que o grafo fique legível.

## Publicando e rodando

Um loop começa como um **Draft**. Quando o grafo está válido, faça **Publish** — os loops publicados são os que aparecem no seletor de Loop de um rail. (Faça Unpublish para tirá-lo de circulação sem apagá-lo.)

Para rodar um loop personalizado:

1. Abra um projeto e arraste uma spec para um rail.
2. No cabeçalho do rail, abra o **seletor de Loop** e escolha o seu loop publicado.
3. Aperte **▶ Play**.

A execução transmite ao vivo na vista **Jobs** com as mesmas métricas e o mesmo rastreamento de custo de qualquer job de rail — e o seu log ganha um **explorador de passos** dedicado: um mapa ao vivo do seu grafo com uma caixa recolhível por passo, seguindo o passo em execução à medida que o loop avança (ver [A vista de detalhe do job](the-job-detail-view)). No Claude, cada **Passo de IA** é também uma sessão ao vivo: envie mensagens a ele pelo compositor do detalhe do job para orientá-lo no meio do passo (entre passos o compositor espera brevemente, e **Assentar este passo** faz o loop avançar com o que o passo produziu). Um loop que para porque atingiu seu teto de iterações ou de custo é reportado com esse resultado, em vez de um simples sucesso.

> **Atenção enquanto um loop roda.** Você não pode editar nem apagar um loop enquanto uma de suas execuções está rodando — pare a execução primeiro.

## Para onde ir agora

- [Rails e jobs](rails-and-jobs) — lançando rails e a fila de jobs.
- [A vista de detalhe do job](the-job-detail-view) — acompanhando uma execução ao vivo.
- [Escolhendo um motor por rail](picking-an-engine-per-rail) — o rail (não o loop) escolhe o provedor.
