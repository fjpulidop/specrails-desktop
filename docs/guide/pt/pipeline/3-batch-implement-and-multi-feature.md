# Batch implement e multi-feature

Uma spec de cada vez está bem, mas muito do trabalho real vem em conjuntos — uma feature mais os seus testes mais a sua migração, ou um backlog que quer despachar numa só sessão. Esta página cobre correr várias specs em conjunto: o modo Batch, as ondas de dependências e como o pipeline impede que trabalho concorrente colida.

## Correr várias specs ao mesmo tempo

A forma mais simples de correr um monte de specs a partir de um rail é o modo **Batch**:

1. **Arraste todas as specs** que quer para um único rail. Empilham-se na lista de specs desse rail.
2. **Mude o modo do rail para Batch** (o controlo segmentado no cabeçalho do rail).
3. **Carregue em ▶ Play.**

O rail lança **um** job `/specrails:batch-implement` que trabalha cada spec atribuída. Monitorize-o como qualquer outro job na página Jobs — é um único job que cobre todo o conjunto, não um job por spec.

O modo Batch continua a ser a forma mais limpa de *sequenciar* specs relacionadas, porque mantém a ordem das dependências dentro de um só rail. Se as specs forem independentes, também pode distribuí-las por vários rails: rails apoiados por git correm em paralelo e cada um recebe o seu próprio worktree isolado.

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

Quando a execução termina, **nada é enviado e ainda não é aberto nenhum pull request**. O trabalho fica commitado em segurança nos seus branches isolados, as specs passam a um novo estado **Em revisão**, e o specrails **pergunta-lhe primeiro**: no rail aparece uma barra de decisão persistente com **Criar PR** — um pull request em rascunho a partir do branch de integração designado do seu projeto (defina-o em **Settings → Integration branch**; por omissão é o branch por defeito do seu repositório), combinado através de todas as specs do rail — e **Descartar**. O specrails **nunca faz merge, e nunca faz commit diretamente no seu branch de integração** — é você quem decide se sequer existe um PR, e um humano é responsável pelo merge. É a passagem de testemunho segura: o specrails produz o pull request apenas quando você o autoriza, e os seus engenheiros revêem-no e fazem merge no GitHub da forma como já o fazem.

Se relançar uma spec que já está em revisão e tem um pull request aberto, o Specrails trata isso como trabalho de seguimento. Deteta a PR ativa a partir do seu próprio registo de entrega ou de referências GitHub/Jira, faz checkout da branch head dessa PR, commita aí as novas alterações e volta a mostrar o mesmo cartão de PR. Trabalho novo continua a começar a partir da branch de integração.

Na prática isto significa:

- Cada spec recebe um ponto de partida limpo para implementar, em vez de herdar as edições em curso da spec anterior a meio do processo.
- A sua árvore de trabalho nunca é modificada enquanto a execução decorre — nada é aplicado até você o autorizar.
- Quando a execução termina, as specs mostram um selo **Em revisão** e o rail faz-lhe a pergunta: **Criar PR** para abrir o pull request em rascunho combinado, ou **Descartar** para limpar os branches e devolver as specs ao backlog. Se lançou o rail a partir do chat do agente, a mesma pergunta aparece como um cartão nessa conversa — responda em qualquer um dos dois lugares: ambos ficam sincronizados.
- Depois de criado, **Abrir PR** mostra o rascunho, **Publicar** abre-o à revisão e entrega-o à revisão normal da sua equipa no GitHub, e **Verificar merge** passa as specs a Concluído assim que a sua equipa o tiver mergeado.
- Se os branches isolados não puderem ser combinados de forma limpa ao criar o PR, o specrails para em segurança e deixa os branches para um humano — nunca força um merge partido sobre a sua base. Pode tentar de novo ou descartar a partir da mesma barra.

> Criar ou continuar uma PR precisa de um repositório git, do GitHub CLI (`gh`) autenticado e de um remote configurado. Sem `gh` ou sem remote, o specrails mantém na mesma o trabalho commitado num branch a partir do qual pode abrir um pull request por si mesmo — nada se perde, e a barra de decisão permite tentar de novo. Sem git, não há grafo de branches a continuar: o rail corre na pasta compartilhada e não aparece nenhum cartão de PR. Para voltar ao comportamento anterior (integrar localmente em vez de perguntar), defina `SPECRAILS_RAIL_DELIVER_PR=0`.

## Multi-feature entre projetos

Se quiser paralelismo genuíno, use vários rails para specs independentes no mesmo projeto apoiado por git, ou divida o trabalho entre projetos. Cada rail ativo recebe o seu próprio worktree isolado, por isso:

```
Projeto A   ▶ Rail a correr a feature X   ┐
                                          ├─ correm em simultâneo
Projeto B   ▶ Rail a correr a feature Y   ┘
```

Não há limite global de concorrência para ajustar. Abra os projetos ou rails de que precisa, lance-os e progridem juntos. O único limitador partilhado é o seu limite de orçamento, que pausa as filas por projeto ou da app inteira assim que o gasto do dia atinge o limite.

## Dicas para batches grandes

- **Agrupe specs relacionadas num só rail** antes de mudar para Batch — as ondas de dependências só veem o que está nesse rail.
- **Defina um orçamento diário** antes de um batch grande para que uma execução inesperadamente cara faça auto-pausa em vez de descontrolar-se. Configure-o em [Orçamento](../settings/customizing).
- **Use o botão Comparar** na página Jobs depois para comparar duas execuções de batch lado a lado.
- **Exporte um diagnóstico** (se a telemetria estava ligada) para obter o snapshot exato de perfil + plugins de todo o batch.

## Para onde ir a seguir

- [Rails e jobs](rails-and-jobs) — o modelo da fila em detalhe.
- [A vista de detalhe do job](the-job-detail-view) — ver um batch a correr ao vivo.
- [Escolher um motor por rail](picking-an-engine-per-rail) — note que o Batch corre em qualquer fornecedor; o Freestyle é só Claude.
