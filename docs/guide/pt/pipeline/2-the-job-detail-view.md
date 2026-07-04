# A vista de detalhe do job

Clique em qualquer cartão de job na página **Jobs** e chega aqui: o cockpit de uma única execução de rail. Foi construída em torno de uma promessa — **os números ao vivo que vê são reais, nunca estimativas.** Esta página percorre as fases, as métricas ao vivo, os cartões de ticket — e o compositor que lhe permite **falar com o job em execução**.

## O layout

Dois painéis ficam por cima do log completo em streaming; num job Claude em execução, um compositor de chat fica por baixo:

```
┌─────────────────────────────────────────────┐
│  Cabeçalho de estado  (ícone · duração · …) │
├─────────────────────────────────────────────┤
│  Cabeçalho de tickets  ( #12  #14  #15 )    │
├─────────────────────────────────────────────┤
│                                             │
│  Log em streaming  (auto-scroll · pesquisa) │
│                                             │
├─────────────────────────────────────────────┤
│  Compositor  (envie uma mensagem ao job · …)│
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

## Execuções de loop: o explorador de passos

Quando o job é uma **execução de loop** (ver [O Loop Builder](the-loop-builder)), o log plano dá lugar a um **explorador de passos** que espelha a forma real do loop:

- **A faixa de visão geral** no topo é o mapa ao vivo do loop — um chip por nó (Passo de IA, Shell, Decisor do Loop…), na ordem em que o grafo flui. Os chips vão acendendo à medida que a execução avança: esmaecidos enquanto esperam, pulsando enquanto correm, e depois um visto ou uma cruz. O chip de um Decisor mostra ainda o veredicto pelo qual encaminhou — voltar ao início ou seguir em frente — e um contador de iterações (`Iteração 3/10`) mantém a conta à direita. Clique em qualquer chip para saltar direto ao passo mais recente daquele nó.
- **Uma caixa recolhível por passo.** Cada passagem por um nó vira a sua própria secção, com o número do passo, o nome, um selo de iteração, a duração ao terminar — e o seu próprio botão de copiar, para levar exatamente a saída de um passo. (O copiar da barra de ferramentas continua a levar o log inteiro.) Tudo o que foi impresso antes do primeiro passo — o banner de arranque, o aviso de worktree — fica arrumado numa secção de **Preparação**.
- **O modo de acompanhamento** vem ligado por defeito: o passo em execução permanece aberto e com auto-scroll enquanto os anteriores se recolhem. No momento em que sobe o scroll ou abre um passo antigo, o acompanhamento pausa para poder ler — uma pílula flutuante **Retomar acompanhamento** devolve-o ao direto. **Expandir tudo / Recolher tudo** vivem na barra de ferramentas, e escrever na pesquisa procura em todos os passos ao mesmo tempo.
- **Os passos interrompidos também são honestos.** Um passo que nunca chegou a reportar o seu desfecho — a execução foi cancelada ou a app fechou a meio do passo — é marcado como **Interrompido** com uma borda tracejada, em vez de fingir que terminou.

Tudo o resto nesta página funciona exatamente igual nas execuções de loop — as métricas ao vivo, os cartões de ticket, o compositor. Os jobs que não são de loop mantêm o log em streaming clássico acima.

## Fale com o job em execução

Todo job Claude corre por omissão como uma **sessão ao vivo**, por isso um compositor de chat fica ao fundo desta página — e do modal de job no modo missão. Use-o para fazer uma pergunta ao agente em execução («porque é que aquele teste falhou?») ou para o orientar a meio da execução («salta o refactor, concentra-te no fix»).

Algumas coisas que vale a pena saber:

- **As mensagens entram em fila, não interrompem.** Envie enquanto o agente está a transmitir e a sua mensagem espera a vez — corre como o prompt seguinte, e o job continua a seguir o seu plano. Um pequeno contador mostra quantas mensagens estão em fila.
- **A linha de totais é real.** O compositor mostra um resumo ao vivo `N turnos · $X`, somado a partir do uso real de cada turno concluído — coerente com a promessa desta página de nunca adivinhar.
- **Duas formas de uma sessão terminar.** A maioria dos jobs **termina sozinha**: assim que um turno acaba sem mensagens em fila, a sessão assenta e o job conclui — as suas mensagens são orientação opcional, nunca uma obrigação. Uma ação discreta **Concluir agora** termina-a mais cedo com tudo o que foi produzido até então. Os jobs **Freestyle** são a exceção: ficam à espera entre turnos até que clique em **Finalize** — é esse o seu desenho, uma sessão de ida e volta que fecha quando terminar.
- **Nas execuções de loop, as mensagens vão para o passo ativo.** Num loop embutido ou personalizado, a sua mensagem chega ao **passo de IA que está a correr nesse momento**. Entre passos (enquanto o Loop Decider pensa, ou um comando de shell corre) o compositor mostra um breve estado *«À espera do próximo passo…»* — o texto rascunhado mantém-se, e o envio reativa-se quando o próximo passo de IA arranca. **Assentar este passo** termina o passo atual mais cedo e deixa o loop avançar com o que ele produziu.
- **Só Claude, por agora.** Os jobs Codex e Gemini correm numa só passagem exatamente como antes — não aparece compositor. (Os operadores do servidor podem desligar a funcionalidade inteira com `SPECRAILS_INTERACTIVE_JOBS=false`.)

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
