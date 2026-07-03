# Batch implement e multi-feature

Uma spec de cada vez está bem, mas muito do trabalho real vem em conjuntos — uma feature mais os seus testes mais a sua migração, ou um backlog que quer despachar numa só sessão. Esta página cobre correr várias specs em conjunto: o modo Batch, as ondas de dependências e como o pipeline impede que trabalho concorrente colida.

## Correr várias specs ao mesmo tempo

A forma mais simples de correr um monte de specs a partir de um rail é o modo **Batch**:

1. **Arraste todas as specs** que quer para um único rail. Empilham-se na lista de specs desse rail.
2. **Mude o modo do rail para Batch** (o controlo segmentado no cabeçalho do rail).
3. **Carregue em ▶ Play.**

O rail lança **um** job `/specrails:batch-implement` que trabalha cada spec atribuída. Monitorize-o como qualquer outro job na página Jobs — é um único job que cobre todo o conjunto, não um job por spec.

Isto importa por causa da **fila de um job por projeto**. Como um projeto só corre um job de rail de cada vez, o modo Batch é também a forma mais limpa de *encadear* uma lista de specs sem andar a fazer malabarismo com vários rails e à espera que cada um esvazie.

### Implement vs Batch — que modo?

| | **Implement** | **Batch** |
|---|---|---|
| Comando | `/specrails:implement` | `/specrails:batch-implement` |
| Specs por job | Todas as do rail, tratadas como uma unidade de trabalho | Todas as do rail, trabalhadas **sequencialmente** |
| Ideal para | Uma alteração fortemente acoplada | Várias features distintas que quer despachar por ordem |
| Ordenação | n/a | Ondas que respeitam as dependências (ver abaixo) |

Se as specs são realmente uma só alteração, use **Implement**. Se são uma lista de features separadas, use **Batch** e deixe-o sequenciá-las.

## Ondas de dependências

O modo Batch não corre as specs simplesmente de cima para baixo — calcula uma **ordem de execução que respeita as dependências** e agrupa as specs em *ondas*. O orquestrador (`/specrails:batch-implement`) descobre quais specs dependem de quais e depois agenda-as de forma a que nada corra antes do trabalho em que assenta.

Conceptualmente:

```
Onda 1:  #2 (modelo de dados)     ← sem dependências, corre primeiro
Onda 2:  #4 (API sobre o modelo)  ← espera por #2
         #5 (CLI sobre o modelo)  ← espera por #2
Onda 3:  #7 (docs sobre tudo)     ← espera por #4 e #5
```

Dentro do job, as specs de cada onda são implementadas antes de a onda seguinte começar. Não configura isto à mão — o orquestrador deriva as ondas a partir das próprias specs. Veja-o desenrolar-se na [vista de detalhe do job](the-job-detail-view): o log em streaming narra em que spec o batch está, e o cabeçalho de tickets mostra todas as specs que o job tocou.

## Isolamento por worktree e como o trabalho é entregue

Quando várias specs são implementadas numa só execução, o pipeline mantém cada unidade de trabalho isolada para que alterações concorrentes ou sequenciais não pisem os ficheiros umas das outras. A implementação de cada spec corre no seu próprio **git worktree** limpo — um checkout separado que partilha o histórico do seu repositório mas nunca toca na sua árvore de trabalho enquanto a IA trabalha.

Quando a execução termina, os branches isolados são reunidos e entregues como **um pull request em rascunho** a partir do branch de integração designado do seu projeto (defina-o em **Settings → Integration branch**; por omissão é o branch por defeito do seu repositório). O specrails **nunca faz merge, e nunca faz commit diretamente no seu branch de integração** — recebe um PR em rascunho para rever, e um humano é responsável pelo merge. É a passagem de testemunho segura: o specrails produz o pull request, os seus engenheiros revêem-no e fazem merge no GitHub da forma como já o fazem.

Na prática isto significa:

- Cada spec recebe um ponto de partida limpo para implementar, em vez de herdar as edições em curso da spec anterior a meio do processo.
- A sua árvore de trabalho nunca é modificada enquanto a execução decorre — nada é aplicado até você o autorizar.
- Quando a execução termina, recebe uma notificação com o PR em rascunho: **Open PR** para o ver, ou **Approve** para o promover a pronto-para-revisão e entregá-lo à revisão normal da sua equipa no GitHub.
- Se os branches isolados não puderem ser combinados de forma limpa, o specrails para em segurança e deixa os branches para um humano — nunca força um merge partido sobre a sua base.

> A entrega do PR precisa do GitHub CLI (`gh`) autenticado e de um remote configurado. Sem eles, o specrails na mesma faz commit do trabalho para um branch a partir do qual pode abrir um pull request por si mesmo — nada se perde. Para voltar ao comportamento anterior (integrar localmente em vez de abrir um PR), defina `SPECRAILS_RAIL_DELIVER_PR=0`.

## Multi-feature entre projetos

Se quiser paralelismo genuíno — duas grandes features a construir ao mesmo tempo — divida-as **entre projetos**, não entre rails de um mesmo projeto. Cada projeto tem a sua fila independente, por isso:

```
Projeto A   ▶ Rail a correr a feature X   ┐
                                          ├─ correm em simultâneo
Projeto B   ▶ Rail a correr a feature Y   ┘
```

Não há limite global de concorrência nem disputa entre projetos. Abra os dois, lance um rail em cada e progridem juntos. O único limitador partilhado é o seu limite de orçamento, que pausa as filas por projeto ou da app inteira assim que o gasto do dia atinge o limite.

## Dicas para batches grandes

- **Agrupe specs relacionadas num só rail** antes de mudar para Batch — as ondas de dependências só veem o que está nesse rail.
- **Defina um orçamento diário** antes de um batch grande para que uma execução inesperadamente cara faça auto-pausa em vez de descontrolar-se. Configure-o em [Orçamento](../settings/customizing).
- **Use o botão Comparar** na página Jobs depois para comparar duas execuções de batch lado a lado.
- **Exporte um diagnóstico** (se a telemetria estava ligada) para obter o snapshot exato de perfil + plugins de todo o batch.

## Para onde ir a seguir

- [Rails e jobs](rails-and-jobs) — o modelo da fila em detalhe.
- [A vista de detalhe do job](the-job-detail-view) — ver um batch a correr ao vivo.
- [Escolher um motor por rail](picking-an-engine-per-rail) — note que o Batch corre em qualquer fornecedor; o Ultra é só Claude.
