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

Você pode ter vários rails para organizar o trabalho em pistas nomeadas (uma para a feature em que está focado, outra na fila atrás dela). Os rails são **dinâmicos**: o botão **+ Adicionar** no cabeçalho de Rails cria uma nova pista (até 12 por projeto) e pistas vazias e ociosas podem ser removidas. Cada rail é respaldado pelo servidor, então seu conjunto de pistas sobrevive a recargas e fica visível para o companion móvel e para o agente integrado — o agente pode até criar um rail sozinho quando todas as pistas estão ocupadas.

## Lançando um rail sobre uma spec

1. **Arraste um cartão de spec** do SpecsBoard para um rail. O ID da spec aparece na lista de specs do rail. (Prefere não arrastar? Use o popover **Mover para o rail** no cartão da spec — ele mostra um indicador de status por rail, para você não soltar trabalho numa pista ocupada.)
2. **Escolha um Loop** no cabeçalho do rail. Um rail roda um **Loop** — é o trabalho que ele realiza. O padrão é o Loop `Implement` embutido; você também pode escolher `Freestyle` ou um loop personalizado que você mesmo construiu. Veja [O Loop Builder](the-loop-builder).
3. **Aperte ▶ Play.**

É isso. O rail sobe um processo de CLI de IA no contexto de execução certo e começa o pipeline.

### O que tem no cabeçalho de um rail

| Controle | O que faz |
|---------|--------------|
| **Pílula de status** | `idle`, `running` ou `failed`. Não há um "completed" separado — um rail volta para `idle` quando seu job termina sem erros. |
| **Lista de specs** | Os IDs atribuídos a este rail. Arraste mais para dentro, arraste para fora para desanexar. |
| **Seletor de Loop** | O Loop que este rail roda — um embutido (`Implement` / `Freestyle` / `SDD Quick (OpenSpec)`) ou um loop personalizado. Veja a tabela abaixo. Persistido por rail. |
| **▶ Play / ■ Stop** | Iniciar ou cancelar. |

### O que um rail roda: Loops {#rail-loops}

Um rail roda um **Loop** — a receita do trabalho. Dois loops são **embutidos** e cobrem os casos comuns:

| Loop embutido | Comando | O que faz |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | Um job cobrindo todas as specs do rail. Roda o pipeline completo Architect → Developer → Reviewer → Ship. O padrão do dia a dia. |
| **Freestyle** | Freestyle | O provedor do rail implementa cada spec de forma autônoma, **sem** o pipeline; depois a verificação e o Loop Decider refinam o resultado até tudo passar. Uma execução independente por spec. Funciona com Claude, Codex, Gemini, Kimi e motores locais; o chat interativo dentro do job é exclusivo do Claude. |

Para rodar várias specs, coloque as relacionadas (até 3) num único rail — o `Implement` executa-as como um só job agregado — ou distribua specs independentes por vários rails: cada rail com git roda em paralelo na sua própria worktree isolada.

Os embutidos também são editáveis: edite um no Loop Builder e publique-o, e todos os rails que o escolhem rodam a sua versão (use **Restaurar original** para voltar atrás).

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

## Parando tudo

Se algo parecer errado:

- **Um rail** — clique em **■ Stop** no cabeçalho dele.
- **Autopausa por orçamento** — defina um orçamento diário e a fila se pausa sozinha quando o gasto do dia atinge o teto.
- **Tudo** — feche o app desktop, ou rode `specrails-desktop stop`.

## Integrar localmente com alterações sem commit

**Integrar localmente** junta uma entrega aprovada no seu branch de integração (por exemplo `main`) neste computador, sem PR. Não precisa de um checkout limpo:

- As alterações sem commit que não tocam nos ficheiros entregues ficam onde estão.
- Se as suas alterações tocam nos mesmos ficheiros, o Specrails guarda-as num git stash chamado `specrails: before integrating #N (…)`, integra e volta a colocá-las. O aviso diz *Guardei as suas alterações locais, integrei #N e restaurei-as.*
- Se ao voltar a colocá-las houver conflitos com o código integrado, o Specrails deixa o branch exatamente como integrado e **mantém o stash**: nada se perde. O cartão mostra *As suas alterações locais estão guardadas num stash* com os ficheiros em conflito, **Restaurar as minhas alterações** (nova tentativa, por exemplo depois de alterar o código) e o nome do stash para copiar. Depois, o Specrails restaura-as ele próprio num novo branch `specrails/restore-local-<id>`, num worktree separado: se aí se aplicarem sem conflitos, faz commit; caso contrário, um resolvedor de conflitos com IA trabalha apenas dentro desse worktree, mantendo a sua intenção e o código integrado, e o Specrails faz commit do resultado. O cartão lista os ficheiros restaurados; **Trazê-las de volta para <branch>** coloca-as no seu branch (só então o stash é descartado) e **Descartar o branch restaurado** remove o branch e mantém o stash. Uma missão é apenas informada; nunca tem de executar nada. As skills e comandos OpenSpec gerados pelo Specrails (por exemplo `.claude/skills/openspec-*/SKILL.md`) não contam como alterações suas: num conflito mantêm a versão integrada.
- Os ficheiros ignorados nunca vão para o stash: se algum colidir com a entrega, o Specrails pede-lhe que o mova primeiro.
- Se a app parar entre guardar e restaurar, restaura as suas alterações da próxima vez que o projeto abrir (só se o mesmo branch estiver em checkout).

## Previsão de tempo e custo {#launch-forecast}

Antes de clicar em Iniciar, um rail pode mostrar quanto tempo execuções como esta costumam levar e, quando faz sentido, quanto costumam custar, por exemplo *Normalmente 6–9 min · $2–4 em execuções como esta*.

O intervalo é a metade central do seu próprio histórico: do percentil 25 ao 75 das execuções concluídas neste projeto com o mesmo loop ou comando e o mesmo motor. Precisa de pelo menos 5 execuções comparáveis. Até lá, a linha diz *Ainda sem histórico suficiente* em vez de um palpite. Só entram custos informados pelo provedor; custos estimados ficam de fora. É uma estimativa, nunca uma cobrança.

O valor em dólares só aparece quando se sabe que o motor cobra por uso (por exemplo, uma chave de API). Em um plano de assinatura, ou enquanto o modo de cobrança ainda não é conhecido, só o tempo aparece. Quando o rail tem várias specs, o intervalo vale para uma spec e diz isso com *(por spec)*. Se o gasto de hoje mais o topo do intervalo puder atingir o seu orçamento diário, a linha acrescenta *Pode pausar no orçamento* com um link para as configurações de orçamento. Se o orçamento de hoje já acabou, Iniciar pede confirmação antes, porque a execução ficaria em pausa até ser reiniciado.


## Para onde ir agora

- [O Loop Builder](the-loop-builder) — o que um rail roda, e como construir seus próprios loops.
- [A vista de detalhe do job](the-job-detail-view) — fases, métricas ao vivo, cartões de ticket.
