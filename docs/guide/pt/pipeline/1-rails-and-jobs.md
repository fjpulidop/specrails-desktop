# Rails e jobs

Já tem specs no quadro. É aqui que elas se transformam em código. Um **rail** é a faixa que conduz uma spec por todo o pipeline — Architect → Developer → Reviewer → Ship — executando agentes de IA reais dentro da diretoria do seu projeto. Esta página cobre o lançamento de um rail, a fila de jobs e como acompanhar o trabalho a acontecer ao vivo.

## O que é um rail

Imagine o seu ecrã dividido em dois:

```
SpecsBoard (esquerda)       Rails (direita)
─────────────────           ─────────────────
#1 Login flow      ─┐
#2 Webhook retry    │  arrastar para
#3 Cost limits      │ ────────────►   Rail 1   ▶ Play
#4 Audit log        │
                    └────────────►   Rail 2   ▶ Play
```

Um rail é uma **faixa de execução**. Arrasta um cartão de spec do SpecsBoard para um rail e depois carrega em **▶ Play**. O rail lança o pipeline e trabalha a spec de ponta a ponta, mesmo na diretoria de trabalho do seu projeto — editando ficheiros, correndo testes, tudo.

Pode ter vários rails para organizar o trabalho em faixas com nome (uma para a feature em que está focado, outra em fila atrás dela). Mais sobre múltiplos rails e batches em [Batch implement e multi-feature](batch-implement-and-multi-feature).

## Lançar um rail sobre uma spec

1. **Arraste um cartão de spec** do SpecsBoard para um rail. O ID da spec aparece na lista de specs do rail. (Prefere não arrastar? Use o popover **Mover para um rail** no cartão de spec — mostra um ponto de estado por rail para que não largue trabalho numa faixa ocupada.)
2. **Escolha um modo** se quiser algo diferente do default — o controlo segmentado no cabeçalho do rail oferece `Implement`, `Batch` e (apenas rails Claude) `Ultra`.
3. **Carregue em ▶ Play.**

É só isto. O rail arranca um processo de CLI de IA no seu projeto e inicia o pipeline.

### O que há no cabeçalho de um rail

| Controlo | O que faz |
|---------|--------------|
| **Pílula de estado** | `idle`, `running` ou `failed`. Não há um "completed" separado — um rail volta a `idle` quando o seu job termina sem problemas. |
| **Lista de specs** | Os IDs atribuídos a este rail. Arraste mais para dentro, arraste para fora para os desligar. |
| **Controlo de modo** | `Implement` / `Batch` / `Ultra` — veja a tabela abaixo. Guardado por rail. |
| **Seletor de perfil** | Que perfil de agentes corre (apenas rails Claude). Só aparece quando o projeto tem pelo menos um perfil. |
| **Seletor de motor** | Que fornecedor instalado corre este rail — Claude, Codex ou Gemini. Só aparece quando o projeto tem mais do que um fornecedor. Veja [Escolher um motor por rail](picking-an-engine-per-rail). |
| **▶ Play / ■ Stop** | Iniciar ou cancelar. |

### Os três modos de rail

| Modo | Comando | O que faz |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | Um único job que cobre todas as specs do rail. Corre o pipeline completo Architect → Developer → Reviewer → Ship. O default do dia a dia. |
| **Batch** | `/specrails:batch-implement` | Um único job que trabalha as specs do rail sequencialmente, em ondas que respeitam as dependências. Ideal para várias specs relacionadas. |
| **Ultra** | Ultracode | O Claude implementa cada spec de forma autónoma, **ignorando** o pipeline. Um job independente por spec. Só Claude. |

O Ultra é o caso à parte: salta a cadeia de agentes e entrega ao Claude a spec em bruto para trabalhar com as suas ferramentas nativas. É aberto, por isso carregar em Play abre primeiro uma confirmação, e um seletor de modelo por rail deixa-o escolher Haiku / Sonnet / Opus. Só aparece quando o motor do rail é o Claude.

## A fila de jobs

Sempre que carrega em Play, a execução do rail torna-se um **job**. A regra mais importante para interiorizar:

> **Um job de cada vez, por projeto.** Cada projeto tem uma única fila. Dentro de um projeto, só um job de rail corre de cada vez — os restantes ficam em fila atrás dele e arrancam automaticamente à medida que se libertam slots.

Isto surpreende quem adiciona três rails à espera de que corram em paralelo. Não correm — não dentro do mesmo projeto. Adicionar rails *organiza* o seu trabalho em faixas; não faz com que essas faixas corram em simultâneo.

**O paralelismo real é entre projetos.** Cada projeto tem a sua fila independente, por isso um rail no Projeto A e um rail no Projeto B correm ao mesmo tempo sem disputar recursos. Quer mais throughput? Abra mais projetos.

Não há um botão global de concorrência para afinar. O único limitador automático é baseado no orçamento: se definiu um orçamento diário (do projeto ou da app), a fila pausa automaticamente assim que o gasto desse dia atinge o limite.

## Acompanhar a execução

Encontra todos os jobs em **Jobs**, na barra lateral direita do projeto — uma lista de cartões, do mais recente para o mais antigo. Cada cartão mostra um selo de estado, o selo do perfil, um selo de prioridade, a duração, o custo e o comando lançado. Por cima da lista:

- **Chips de filtro por estado** — mostram apenas os jobs num dado estado.
- **Filtro por intervalo de datas** — restringe a uma janela temporal.
- **Comparar** — escolhe dois jobs e vê-os lado a lado.

Clique em qualquer cartão para abrir a **vista de detalhe do job**, onde vivem o log em streaming ao vivo e as métricas ao vivo. É a próxima página: [A vista de detalhe do job](the-job-detail-view).

## Cancelar um job

Carregue em **■ Stop** no cabeçalho do rail. A app envia `SIGTERM` ao subprocesso, espera **5 segundos** por uma saída limpa e depois faz `SIGKILL`. Nada fica criado pela metade.

## Se um rail não arrancar

Se escolher um motor cuja CLI não está instalada na sua máquina, o lançamento **falha de imediato** em vez de iniciar um job partido — nada é criado. Instale a CLI do fornecedor em falta ([Usar o Codex](../integrations/using-codex), [Usar o Gemini](../integrations/using-gemini)) e lance de novo. A falta de Claude ou Codex devolve uma mensagem precisa "*&lt;provider&gt; CLI not found*"; a falta de Gemini mostra hoje um erro de lançamento genérico, mas o resultado é o mesmo.

## Parar tudo

Se algo parecer errado:

- **Um rail** — carregue em **■ Stop** no seu cabeçalho.
- **Auto-pausa por orçamento** — defina um orçamento diário e a fila pausa-se a si própria quando o gasto desse dia atinge o limite.
- **Tudo** — feche a app desktop, ou execute `specrails-desktop stop`.

## Para onde ir a seguir

- [A vista de detalhe do job](the-job-detail-view) — fases, métricas ao vivo, cartões de ticket.
- [Batch implement e multi-feature](batch-implement-and-multi-feature) — correr várias specs ao mesmo tempo.
- [Escolher um motor por rail](picking-an-engine-per-rail) — Claude vs Codex vs Gemini.
