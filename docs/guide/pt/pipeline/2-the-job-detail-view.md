# A vista de detalhe do job

Clique em qualquer cartão de job na página **Jobs** e chega aqui: o cockpit de uma única execução de rail. Foi construída em torno de uma promessa — **os números ao vivo que vê são reais, nunca estimativas.** Esta página percorre as fases, as métricas ao vivo e os cartões de ticket.

## O layout

Dois painéis ficam por cima do log completo em streaming:

```
┌─────────────────────────────────────────────┐
│  Cabeçalho de estado  (ícone · duração · …) │
├─────────────────────────────────────────────┤
│  Cabeçalho de tickets  ( #12  #14  #15 )    │
├─────────────────────────────────────────────┤
│                                             │
│  Log em streaming  (auto-scroll · pesquisa) │
│                                             │
└─────────────────────────────────────────────┘
```

## Fases do pipeline

Para os jobs `Implement` e `Batch`, a execução percorre as fases definidas pelo slash command — por default:

```
Architect ──► Developer ──► Reviewer ──► Ship
```

Cada fase é um agente especializado que o motor do rail invoca na diretoria do seu projeto:

| Fase | Agente | O que faz |
|-------|-------|--------------|
| **Architect** | `sr-architect` | Planeia a implementação. |
| **Developer** | `sr-developer` | Escreve o código. |
| **Reviewer** | `sr-reviewer` | Revê o resultado. |
| **Ship** | (varia) | Finalização: testes, commit, rascunho de PR. |

Que agente trata de cada fase é decidido pelo **perfil de agentes** do projeto. O trio base (`sr-architect`, `sr-developer`, `sr-reviewer`) está sempre presente; as regras de encaminhamento de um perfil podem acrescentar agentes ou trocar qual deles corre uma fase. A barra de progresso das fases só aparece quando o comando define mesmo fases — os jobs Freestyle (que ignoram o pipeline) não mostram nenhuma.

## Métricas ao vivo — honestas por princípio

O cabeçalho de estado é a manchete. Mostra um ícone de estado, uma linha de atividade a descrever o que o job está a fazer *neste momento*, uma contagem dos passos dados e uma fila de métricas:

| Métrica | Quando vê o valor real |
|--------|------------------------------|
| **Duração** | **Ao vivo.** Um contador de 1 segundo vai subindo enquanto o job corre — este é o único número genuinamente ao vivo. |
| **Turnos** | Derivados incrementalmente dos eventos de assistant transmitidos à medida que chegam. |
| **Tokens** | Agregados incrementalmente a partir do mesmo stream (tolerante a eventos sem campos de uso). |
| **Custo** | Mostrado como `—` até o job terminar, e depois revelado como o valor autoritativo `total_cost_usd`. |

O princípio de design: **nada de números aproximados ou estimados a meio da execução.** A duração é real porque não passa de um relógio. Turnos e tokens são acumulados a partir de atividade realmente transmitida. O custo *não* é estimado de propósito durante a execução — aparece como pendente e só passa ao seu valor final e autoritativo quando o fornecedor o reporta na saída do job. Se um número parecer estar à espera, é intencional — está a ver a verdade, não uma projeção.

A etiqueta e o ícone do cabeçalho correspondem ao estado do job, e o painel é renderizado para jobs `running`, `completed` e `failed` por igual — por isso a vista de detalhe de um job terminado mostra as mesmas métricas congeladas nos seus valores finais.

## Os cartões de ticket

O **cabeçalho de tickets** fica entre o cabeçalho de estado e o log. É um cartão de identidade premium que mostra um chip por cada spec que o job tocou — correspondidos a partir do comando lançado, por isso reflete exatamente quais os tickets de que esta execução tratou.

- **2–3 tickets** — mostrados como uma lista de chips.
- **4 ou mais** — colapsam num modo compacto `+ N more` com um chevron para expandir, para o cabeçalho ficar arrumado.

Clicar num chip abre o detalhe dessa spec **por cima da página do job** — não perde o seu lugar nem muda de rota. É uma forma rápida de reler o que um job deve entregar enquanto o vê trabalhar. (Em ecrãs com largura de tablet pode até arrastar uma modal de ticket para o lado e comparar duas specs lado a lado.)

## O log em streaming

Por baixo dos painéis fica o log completo da execução, transmitido em tempo real pelo WebSocket:

- **Auto-scroll** mantém o output mais recente à vista (faça scroll para cima e pausa, para poder ler).
- **Pesquisa** para saltar para uma frase.
- **Copiar** para agarrar o log inteiro.

Esta é a verdade crua do que a IA está a fazer — cada chamada de ferramenta, cada edição de ficheiro, cada execução de teste.

## Exportação de diagnóstico

Se a [telemetria](../settings/customizing) estava ativada para o job, aparece um botão **Exportar diagnóstico** no cabeçalho. Descarrega um ZIP que contém:

- `job-metadata.json` — comando, estado, perfil, plugins.
- `telemetry.ndjson` — sinais OTLP/JSON não comprimidos.
- `logs.txt` — o log completo em streaming.
- `summary.md` — destaques legíveis por humanos.
- `profile.json`, `plugins.json` — snapshots exatos do que correu (quando presentes).

Útil para partilhar uma execução com um colega de equipa, ou para abrir um relatório de bug preciso.

## Para onde ir a seguir

- [Rails e jobs](rails-and-jobs) — lançar e enfileirar.
- [Batch implement e multi-feature](batch-implement-and-multi-feature) — muitas specs, ondas de dependências.
- [Acompanhar o custo](../analytics/tracking-cost) — transformar os custos por job em analytics do projeto.
