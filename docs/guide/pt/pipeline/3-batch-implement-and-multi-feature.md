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

## Isolamento por worktree

Quando várias specs são implementadas numa só execução, o pipeline mantém cada unidade de trabalho isolada para que alterações concorrentes ou sequenciais não pisem os ficheiros umas das outras. O orquestrador de batch corre a implementação de cada spec no seu próprio contexto de trabalho limpo e depois integra os resultados — por isso uma spec a meio nunca deixa a sua árvore num estado intermédio partido visível para a seguinte.

Na prática isto significa:

- Cada spec recebe um ponto de partida limpo para implementar, em vez de herdar as edições em curso da spec anterior a meio do processo.
- As revisões e os passos de ship operam sobre um snapshot coerente, não sobre um alvo em movimento.
- Uma falha numa onda fica contida — não corrompe em silêncio as specs que já foram entregues.

A app regista, por job, exatamente que ficheiros foram tocados e qual ticket os tocou (vai ver isto surgir como chips de proveniência na secção **Code** e como uma lista "Ficheiros tocados por este ticket" na modal de detalhe de cada spec). É essa atribuição que lhe permite confiar numa execução com várias specs: pode sempre rastrear uma alteração de ficheiro até à spec que a causou.

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
