# Analytics e controlo de custos

Sempre que o Specrails corre uma CLI de IA por si — um job de pipeline, uma quick spec, uma sessão de Explore, um refinamento de IA, um resumo de ficheiro — fica registado o que aconteceu: que modelo correu, quantos tokens entraram e saíram, quanto tempo demorou e quanto custou. A secção **Analytics** transforma tudo isso num único painel, para que saiba sempre para onde vai o seu investimento em IA.

Abra-a a partir da barra lateral direita (tem a etiqueta **Analytics**). Tudo o que vê diz respeito ao projeto em que se encontra neste momento — mude de projeto e os números acompanham-no.

## O que conta como gasto

O Specrails regista cinco tipos de atividade de IA, a que chamamos *superfícies*. Cada uma tem uma cor consistente em todos os gráficos, para a identificar num relance:

- **Job** — um rail de pipeline a correr Architect → Developer → Reviewer → Ship.
- **Quick spec** — uma spec gerada pelo caminho rápido de Add Spec.
- **Explore spec** — uma conversa de Explore em que dá forma a uma spec à medida que conversa.
- **AI edit** — um refinamento assistido por IA sobre um agente ou ficheiro.
- **File summary** — os resumos em linguagem simples que dão vida ao Code explorer.

Há um par de coisas que, propositadamente, *não* são registadas: tanto o chat lateral como o assistente de configuração arrancam CLIs de IA, mas nunca aparecem nos seus gastos. Assim, o painel reflete trabalho real e repetível, em vez de conversa ocasional.

## Ler o painel

A página é composta por um punhado de blocos, de cima para baixo:

### O medidor de consumo (Hero)

O grande número no topo é o seu gasto total para o período selecionado, acompanhado por uma variação **vs anterior**, para perceber num relance se a tendência é de subida ou de descida face à janela anterior. Se acabou de começar a usar um projeto, o estado vazio indica-lhe quando o registo começou ("Registo iniciado em YYYY-MM-DD") — não há preenchimento retroativo de histórico, por isso o medidor só conhece as execuções que aconteceram enquanto estava nesta versão.

### Cronologia diária

Um gráfico de barras empilhadas com o gasto por dia, dividido por superfície. Os dias sem atividade aparecem como zero em vez de serem saltados, para que a forma da sua semana seja honesta. É a forma mais rápida de ver *quando* correu um lote dispendioso.

### Quick vs Explore

Um cartão lado a lado a comparar os seus dois estilos de criação de specs. Se correu menos de cinco sessões de Explore, mostra um convite à ação delicado em vez de médias enganadoras — amostras pequenas não dão comparações de confiança.

### Por modelo

Os seus modelos com mais gasto (até dez). Clique em qualquer modelo para filtrar todo o painel apenas por esse modelo — útil quando quer saber quanto lhe está realmente a custar um modelo topo de gama em particular.

### Dispersão custo vs turnos

Cada ponto é uma invocação, representando o custo face ao número de turnos. Os pontos discrepantes — as execuções caras, de muitos turnos — saltam logo à vista. (A dispersão mostra os seus 500 pontos mais recentes, para se manter ágil.)

### Top tickets

Os seus dez tickets mais caros somando *todas* as superfícies, para que um ticket que custou pouco no Explore e muito num job mostre o seu verdadeiro total. Os tickets eliminados e as execuções sem atribuição ganham os seus próprios baldes, para que nada desapareça silenciosamente dos totais.

### Tabela de invocações em bruto

A verdade dos factos: uma linha por invocação. Este bloco tem os seus próprios filtros secundários, que afetam apenas a tabela, para poder aprofundar sem mexer nos gráficos acima.

## Filtrar

O cabeçalho fixo no topo traz os dois filtros principais — **período** e **superfície** — e ambos ficam guardados no URL da página. Isto significa que pode marcar nos favoritos ou partilhar uma vista filtrada ("últimos 30 dias, só jobs") e ela reabre exatamente como a deixou. Os filtros da tabela em bruto são separados e ficam locais a esse bloco.

Uma nota sobre rigor: as execuções falhadas e abortadas ficam de fora das *médias de custo* (distorceriam os números por execução), mas continuam a contar para o total de execuções e para a taxa de falhas. Assim, as médias mantêm-se limpas enquanto o retrato de fiabilidade se mantém completo.

## Custo por ticket

Não precisa de ir à página de Analytics para ver quanto custou uma spec. Abra qualquer ticket e, se tiver algum gasto associado, vê um resumo numa só linha logo por baixo do título:

> $0.42 · 6 turnos · 1m 12s ativos · detalhe

Clique nele e vai parar à página de Analytics já filtrada por esse ticket. É o caminho mais rápido entre "quanto me custou esta funcionalidade?" e o detalhe completo.

## Exportar os seus dados

Quando precisa dos números fora da aplicação — uma folha de cálculo, um relatório financeiro, a sua própria análise — use o menu **Export**. Oferece quatro formatos:

- **CSV de resumo** — um ficheiro com várias secções, com totais, cronologia diária, por superfície, por modelo e top tickets.
- **JSON de resumo** — o mesmo resumo, estruturado.
- **CSV em bruto** — todas as linhas de invocação (até 10.000; assinala se teve de truncar).
- **JSON em bruto** — as mesmas linhas em bruto, estruturadas.

As exportações respeitam os filtros de período e superfície que tiver aplicados nesse momento, e os ficheiros são nomeados de forma a ordenarem-se com lógica: `<project>-analytics-<period>-<date>.csv`. O botão fica desativado quando não há nada para exportar, e recebe uma notificação de erro clara se uma transferência falhar.

## Sempre em direto

Não precisa de atualizar a página. Quando uma nova invocação é registada em qualquer ponto do projeto, o painel aberto volta a carregar-se discretamente pouco depois, para que o medidor de consumo acompanhe o trabalho à medida que vai terminando.
