# Rails e jobs

Você já tem specs no quadro. É aqui que elas viram código. Um **rail** é a pista que conduz uma spec por todo o pipeline — Architect → Developer → Reviewer → Ship — executando agentes de IA reais dentro do diretório do seu projeto. Esta página cobre como lançar um rail, a fila de jobs e como acompanhar o trabalho acontecendo ao vivo.

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

Um rail é uma **pista de execução**. Você arrasta um cartão de spec do SpecsBoard para um rail e depois aperta **▶ Play**. O rail dispara o pipeline e trabalha a spec de ponta a ponta, bem no diretório de trabalho do seu projeto — editando arquivos, rodando testes, tudo.

Você pode ter vários rails para organizar o trabalho em pistas nomeadas (uma para a feature em que está focado, outra na fila atrás dela). Mais sobre multi-rail e batching em [Batch implement e multi-feature](batch-implement-and-multi-feature).

## Lançando um rail sobre uma spec

1. **Arraste um cartão de spec** do SpecsBoard para um rail. O ID da spec aparece na lista de specs do rail. (Prefere não arrastar? Use o popover **Mover para o rail** no cartão da spec — ele mostra um indicador de status por rail, para você não soltar trabalho numa pista ocupada.)
2. **Escolha um Loop** no cabeçalho do rail. Um rail roda um **Loop** — é o trabalho que ele realiza. O padrão é o Loop `Implement` embutido; você também pode escolher `Batch`, `Freestyle` ou um loop personalizado que você mesmo construiu. Veja [O Loop Builder](the-loop-builder).
3. **Aperte ▶ Play.**

É isso. O rail sobe um processo de CLI de IA no seu projeto e começa o pipeline.

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

O Freestyle é o caso atípico: ele pula a cadeia de agentes e entrega a spec crua ao Claude para trabalhar com suas ferramentas nativas. É aberto, então apertar Play abre primeiro uma confirmação, e um seletor de modelo por rail deixa você escolher Haiku / Sonnet / Opus. Ele só aparece quando o motor do rail é o Claude.

Além dos embutidos, você pode **construir seus próprios loops** — repetir um ciclo verify → fix → verify até atingir uma meta, encadear comandos de shell entre AI Steps e muito mais. Esses loops personalizados aparecem no mesmo seletor de Loop. Essa é a próxima grande ideia: [O Loop Builder](the-loop-builder).

## A fila de jobs

Toda vez que você aperta Play, a execução do rail vira um **job**. A regra mais importante para internalizar:

> **Um job de cada vez, por projeto.** Cada projeto tem uma única fila. Dentro de um projeto, só um job de rail roda por vez — o resto fica na fila atrás dele e inicia automaticamente conforme os slots ficam livres.

Isso surpreende quem adiciona três rails esperando que rodem em paralelo. Eles não vão — não dentro do mesmo projeto. Adicionar rails *organiza* seu trabalho em pistas; isso não faz essas pistas rodarem de forma concorrente.

**O paralelismo de verdade é entre projetos.** Cada projeto tem sua própria fila independente, então um rail no Projeto A e um rail no Projeto B rodam ao mesmo tempo sem disputar recursos. Quer mais throughput? Abra mais projetos.

Não há um botão global de concorrência para ajustar. O único limite automático é baseado em orçamento: se você definiu um orçamento diário (do projeto ou da app), a fila se autopausa assim que o gasto do dia atinge o teto.

## Acompanhando a execução

Encontre todos os jobs em **Jobs**, na barra lateral direita do projeto — uma lista de cartões, os mais recentes primeiro. Cada cartão mostra um selo de status, o selo de perfil, um selo de prioridade, duração, custo e o comando lançado. Acima da lista:

- **Chips de filtro de status** — mostram apenas jobs em um dado status.
- **Filtro por intervalo de datas** — restringe a uma janela de tempo.
- **Comparar** — escolha dois jobs e veja-os lado a lado.

Clique em qualquer cartão para abrir a **vista de detalhe do Job**, onde ficam o log em streaming ao vivo e as métricas ao vivo. Essa é a próxima página: [A vista de detalhe do job](the-job-detail-view).

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
