# Rails e jobs

Você já tem specs no quadro. É aqui que elas viram código. Um **rail** é a pista que conduz uma spec por todo o pipeline — Architect → Developer → Reviewer → Ship — executando agentes de IA reais para o seu projeto. Esta página cobre como lançar um rail, a execução em paralelo e como acompanhar o trabalho acontecendo ao vivo.

## O que é um rail

Imagine sua tela dividida em duas:

```
SpecsBoard (esquerda)       Rails (direita)
─────────────────           ─────────────────
#1 Login flow      ─┐
#2 Webhook retry    │  arraste para
#3 Cost limits      │ ────────────►   Rail 1   ▶ Play
#4 Audit log        │
                    └────────────►   Rail 2   ▶ Play
```

Um rail é uma **pista de execução**. Você arrasta um cartão de spec do SpecsBoard para um rail e depois aperta **▶ Play**. Em repositórios git, o rail dispara o pipeline num git worktree isolado para que a IA possa editar arquivos e rodar testes sem tocar na sua árvore de trabalho ativa. Se o projeto ainda não é um repo git, o Specrails degrada claramente para execução na pasta compartilhada e avisa que não haverá branch nem cartão de PR.

Você pode ter vários rails para organizar o trabalho em pistas nomeadas (uma para a feature em que está focado, outra na fila atrás dela). Os rails são **dinâmicos**: o botão **+ Adicionar** no cabeçalho de Rails cria uma nova pista (até 12 por projeto) e pistas vazias e ociosas podem ser removidas. Cada rail é respaldado pelo servidor, então seu conjunto de pistas sobrevive a recargas e fica visível para o companion móvel e para o agente integrado — o agente pode até criar um rail sozinho quando todas as pistas estão ocupadas. Mais sobre multi-rail e batching em [Batch implement e multi-feature](batch-implement-and-multi-feature).

## Lançando um rail sobre uma spec

1. **Arraste um cartão de spec** do SpecsBoard para um rail. O ID da spec aparece na lista de specs do rail. (Prefere não arrastar? Use o popover **Mover para o rail** no cartão da spec — ele mostra um indicador de status por rail, para você não soltar trabalho numa pista ocupada.)
2. **Escolha um Loop** no cabeçalho do rail. Um rail roda um **Loop** — é o trabalho que ele realiza. O padrão é o Loop `Implement` embutido; você também pode escolher `Batch`, `Freestyle` ou um loop personalizado que você mesmo construiu. Veja [O Loop Builder](the-loop-builder).
3. **Aperte ▶ Play.**

É isso. O rail sobe um processo de CLI de IA no contexto de execução certo e começa o pipeline.

### O que tem no cabeçalho de um rail

| Controle | O que faz |
|---------|--------------|
| **Pílula de status** | `idle`, `running` ou `failed`. Não há um "completed" separado — um rail volta para `idle` quando seu job termina sem erros. |
| **Lista de specs** | Os IDs atribuídos a este rail. Arraste mais para dentro, arraste para fora para desanexar. |
| **Seletor de Loop** | O Loop que este rail roda — um embutido (`Implement` / `Batch` / `Freestyle`) ou um loop personalizado. Veja a tabela abaixo. Persistido por rail. |
| **Seletor de perfil** | Qual perfil de agente roda (apenas rails Claude). Só aparece quando o projeto tem ao menos um perfil. |
| **Seletor de motor** | Qual provedor instalado roda este rail — Claude, Codex ou Gemini. Só é renderizado quando o projeto tem mais de um provedor. Veja [Escolhendo um motor por rail](picking-an-engine-per-rail). |
| **▶ Play / ■ Stop** | Iniciar ou cancelar. |

### O que um rail roda: Loops

Um rail roda um **Loop** — a receita do trabalho. Três loops são **embutidos** e cobrem os casos comuns:

| Loop embutido | Comando | O que faz |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | Um job cobrindo todas as specs do rail. Roda o pipeline completo Architect → Developer → Reviewer → Ship. O padrão do dia a dia. |
| **Batch** | `/specrails:batch-implement` | Um job que percorre as specs do rail sequencialmente, em ondas que respeitam as dependências. Melhor para várias specs relacionadas. |
| **Freestyle** | Freestyle | O Claude implementa cada spec de forma autônoma, **ignorando** o pipeline. Um job independente por spec. Apenas Claude. |

O Freestyle é o caso atípico: ele pula a cadeia de agentes e entrega a spec crua ao Claude para trabalhar com suas ferramentas nativas. É aberto, então apertar Play abre primeiro uma confirmação, e um seletor de modelo por rail deixa você escolher Haiku / Sonnet / Opus. Ele só aparece quando o motor do rail é o Claude. Uma execução Freestyle é também o único job que **fica aberto esperando por você**: converse com ele pelo compositor do detalhe do job e clique em **Finalize** quando estiver satisfeito (todos os outros jobs terminam sozinhos).

Além dos embutidos, você pode **construir seus próprios loops** — repetir um ciclo verify → fix → verify até atingir uma meta, encadear comandos de shell entre AI Steps e muito mais. Esses loops personalizados aparecem no mesmo seletor de Loop. Essa é a próxima grande ideia: [O Loop Builder](the-loop-builder).

## A fila de jobs

Toda vez que você aperta Play, a execução do rail vira um **job**. A regra mais importante para internalizar:

> **Os rails rodam em paralelo.** Cada lançamento apoiado por git isola seu trabalho em um worktree do git por spec, então vários rails podem rodar ao mesmo tempo dentro do mesmo projeto sem se atropelar. Trabalho novo termina num cartão de decisão **Em revisão**, onde você pode criar uma draft PR ou descartar; trabalho de seguimento para uma spec que já tem PR aberta continua a branch dessa PR em vez de recomeçar a partir da branch de integração.

Quer tudo andando de uma vez? O botão **Lançar todos** no cabeçalho de Rails inicia todas as pistas prontas de uma só vez, após uma única confirmação que enquadra o custo total (N rails × gasto de IA). Rails vazios, já em execução ou aguardando uma decisão de PR são pulados e reportados em um toast de resumo compacto. O agente integrado tem o mesmo poder via `specrails_rails(launch_all)` — e cria um rail novo quando não existe pista livre.

Projetos sem git não têm isolamento por worktree nem continuação de PR. Eles ainda podem rodar, mas o rail escreve diretamente na pasta compartilhada do projeto e o resultado é aceito ou revertido manualmente a partir do quadro de specs.

Não há um botão global de concorrência para ajustar. O único limite automático é baseado em orçamento: se você definiu um orçamento diário (do projeto ou da app), a fila se autopausa assim que o gasto do dia atinge o teto.

## Acompanhando a execução

Encontre todos os jobs em **Jobs**, na barra lateral direita do projeto — uma lista de cartões, os mais recentes primeiro. Cada cartão mostra um selo de status, o selo de perfil, um selo de prioridade, duração, custo e o comando lançado. Acima da lista:

- **Chips de filtro de status** — mostram apenas jobs em um dado status.
- **Filtro por intervalo de datas** — restringe a uma janela de tempo.
- **Comparar** — escolha dois jobs e veja-os lado a lado.

Clique em qualquer cartão para abrir a **vista de detalhe do Job**, onde ficam o log em streaming ao vivo e as métricas ao vivo — e onde, nos jobs Claude, um compositor de chat permite **fazer perguntas ao agente em execução ou orientá-lo no meio da execução** sem parar nada. Essa é a próxima página: [A vista de detalhe do job](the-job-detail-view).

## Cancelando um job

Clique em **■ Stop** no cabeçalho do rail. A app envia `SIGTERM` ao subprocesso, espera **5 segundos** por uma saída limpa e então faz `SIGKILL`. Nada fica spawnado pela metade.

## Se um rail não lançar

Se você escolher um motor cuja CLI não está instalada na sua máquina, o lançamento **falha rápido** em vez de iniciar um job quebrado — nada é spawnado. Instale a CLI do provedor que falta ([Usando Codex](../integrations/using-codex), [Usando Gemini](../integrations/using-gemini)) e lance de novo. Claude ou Codex ausentes dão uma mensagem precisa "*&lt;provider&gt; CLI not found*"; o Gemini ausente exibe um erro genérico de lançamento por enquanto, mas o resultado é o mesmo.

## Parando tudo

Se algo parecer errado:

- **Um rail** — clique em **■ Stop** no cabeçalho dele.
- **Autopausa por orçamento** — defina um orçamento diário e a fila se pausa sozinha quando o gasto do dia atinge o teto.
- **Tudo** — feche o app desktop, ou rode `specrails-desktop stop`.

## Para onde ir agora

- [O Loop Builder](the-loop-builder) — o que um rail roda, e como construir seus próprios loops.
- [A vista de detalhe do job](the-job-detail-view) — fases, métricas ao vivo, cartões de ticket.
- [Batch implement e multi-feature](batch-implement-and-multi-feature) — rode várias specs de uma vez.
- [Escolhendo um motor por rail](picking-an-engine-per-rail) — Claude vs Codex vs Gemini.
