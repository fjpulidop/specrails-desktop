# Analytics e controlo de custos

Sempre que o Specrails corre uma CLI de IA por si — um job de pipeline, uma quick spec, uma sessão de Explore, um refinamento de IA, um resumo de ficheiro — fica registado o que aconteceu: que modelo correu, quantos tokens entraram e saíram, quanto tempo demorou e quanto custou. A secção **Analytics** transforma tudo isso num único painel, para que saiba sempre para onde vai o seu investimento em IA.

Abra-a a partir da barra lateral direita (tem a etiqueta **Analytics**). Tudo o que vê diz respeito ao projeto em que se encontra neste momento — mude de projeto e os números acompanham-no.

## O que conta como gasto

Todas as chamadas de IA do projeto contam: jobs de pipeline e passos de loops, escrita de specs, resumos de ficheiros, chats laterais, diagnóstico de falhas, e as missões e turnos de Intent que corre com o agente enquanto está fixado a este projeto. As missões no Início (sem projeto fixado) não pertencem a nenhum projeto e não são contadas aqui.

Cada chamada é etiquetada com a *superfície* que a gastou, e cada superfície pertence a uma de cinco **categorias** que dizem *porquê* se gastou o dinheiro:

- **Implementação** — construir specs com rails, loops e jobs.
- **Missões** — conversar com o agente e modo Intent (turnos de missão, turnos de Intent e a reescrita da spec de Intent).
- **Specs** — escrever e refinar specs: specs Quick e Explore, refinamento, divisão, o lançador de specs, propostas e triagem.
- **Código** — explicar o código: resumos de ficheiros e histórias de ficheiros.
- **Suporte** — configuração, diagnóstico e chats laterais: análise de falhas, configuração, Agent Studio e o chat da barra lateral.

## Ler o painel

A página lê-se de cima para baixo como *quanto → em quê e porquê → quando → com que modelos → as chamadas individuais*.

### O medidor de consumo (Hero)

O grande número no topo é o seu gasto total para o período selecionado, acompanhado por uma variação **vs anterior**, para perceber num relance se a tendência é de subida ou de descida face à janela anterior. Quando todos os motores estão num plano de subscrição, o valor tem a etiqueta *Estimativa equivalente em API*: o que as chamadas custariam a preços de API, não dinheiro que foi cobrado. Se acabou de começar a usar um projeto, o estado vazio indica-lhe quando o registo começou.

### Para onde foi o dinheiro

Uma linha por categoria com o seu custo, a sua parte do total, o número de chamadas e de tokens, e um motivo numa linha. A parte tracejada de uma barra é custo estimado (motores que não reportam o custo nativamente). Abra uma categoria para ver as superfícies que a compõem, e clique numa para filtrar toda a página por ela. A categoria Missões também lista as suas conversas mais caras.

### Cronologia diária

Um gráfico de barras empilhadas com o gasto por dia, dividido por superfície, com as missões na sua própria cor. Os dias sem atividade aparecem como zero em vez de serem saltados. É a forma mais rápida de ver *quando* correu um lote dispendioso.

### Orçamento

Os seus limites diário, semanal, mensal e por execução, a projeção para o fim do mês e o recálculo *E se* (ver abaixo).

### Motores e modelos

O gasto por motor (nos projetos com mais de um) e os seus modelos com mais gasto. Clique em qualquer modelo para filtrar todo o painel apenas por esse modelo.

### Top specs

As suas dez specs mais caras somando *todas* as superfícies, para que uma spec que custou pouco no Explore e muito num job mostre o seu verdadeiro total. Os turnos de missão não têm spec, por isso não aparecem aqui.

### Tabela de invocações em bruto

A verdade dos factos: uma linha por chamada. A coluna **Motivo** mostra a superfície e a sua categoria; as linhas de missão e de Intent mostram a conversa a que pertencem. Este bloco tem os seus próprios filtros secundários, que afetam apenas a tabela.

### Mais detalhamentos

Recolhidos por omissão: tempo até à decisão e ao merge, economia por loop, a dispersão custo vs turnos e a comparação Quick vs Explore.

## Filtrar

O cabeçalho fixo traz os filtros principais — **período**, **categoria** e (nos projetos com vários motores) **motor** — e todos ficam guardados no URL da página, para que possa marcar nos favoritos ou partilhar uma vista filtrada ("últimos 30 dias, só missões"). Passe o rato sobre um chip de categoria para ver o que abrange. Pode selecionar uma única superfície a partir do cartão *Para onde foi o dinheiro* (ou com `?surface=` no URL); um chip removível no cabeçalho mostra-a. Os filtros da tabela em bruto são separados e ficam locais a esse bloco.

Uma nota sobre rigor: as execuções falhadas e abortadas ficam de fora das *médias de custo* (distorceriam os números por execução), mas continuam a contar para o total de execuções e para a taxa de falhas. Assim, as médias mantêm-se limpas enquanto o retrato de fiabilidade se mantém completo.

## Custo por spec

Não precisa de ir à página de Analytics para ver quanto custou uma spec. Abra qualquer spec e, se tiver algum gasto associado, vê um resumo numa só linha logo por baixo do título:

> $0.42 · 6 turnos · 1m 12s ativos · detalhe

Clique nele e vai parar à página de Analytics já filtrada por essa spec. É o caminho mais rápido entre "quanto me custou esta funcionalidade?" e o detalhe completo.

## Todos os projetos {#all-projects}

Para ter o retrato de todos os projetos, abra **Analytics** a partir da barra lateral esquerda ou da paleta de comandos. Mostra o custo total, os jobs e a taxa de sucesso, o custo ao longo do tempo e uma linha por projeto, e usa as mesmas cinco categorias e cores da página do projeto. Os turnos de missão e de Intent contam em todos os valores. Os turnos que não pertencem a nenhum projeto carregado, como as missões do Início e as conversas de Blueprint ou Builder, ficam agrupados numa linha **Início e Blueprint**, contada em turnos do agente em vez de jobs. O custo estimado é marcado com `~`, como na página do projeto.

## Exportar os seus dados

Quando precisa dos números fora da aplicação — uma folha de cálculo, um relatório financeiro, a sua própria análise — use o menu **Export**. Oferece quatro formatos:

- **CSV de resumo** — um ficheiro com várias secções, com totais, cronologia diária, por categoria, por superfície, por modelo e top specs.
- **JSON de resumo** — o mesmo resumo, estruturado.
- **CSV em bruto** — todas as linhas de invocação (até 10.000; assinala se teve de truncar).
- **JSON em bruto** — as mesmas linhas em bruto, estruturadas.

As exportações respeitam os filtros de período, categoria e superfície que tiver aplicados nesse momento, e os ficheiros são nomeados de forma a ordenarem-se com lógica: `<project>-analytics-<period>-<date>.csv`. O botão fica desativado quando não há nada para exportar, e recebe uma notificação de erro clara se uma transferência falhar.

## Sempre em direto

Não precisa de atualizar a página. Quando uma nova invocação é registada em qualquer ponto do projeto, o painel aberto volta a carregar-se discretamente pouco depois, para que o medidor de consumo acompanhe o trabalho à medida que vai terminando.

## Orçamentos diários {#daily-budget}

Defina um orçamento diário para limitar quanto um dia pode custar. Todos os limites (diário, semanal, mensal e por execução) são editados em um único lugar: **Analytics → Orçamento**. **Configurações → Avançado** e **Configurações do projeto → Orçamento** apenas mostram o limite diário atual, com um botão **Abrir Orçamento** que leva até lá.

Quando o gasto registrado do dia atinge um orçamento, a fila se pausa sozinha, os rails e as execuções de loops se recusam a iniciar com *Orçamento diário atingido*, e uma execução de loop em andamento para entre etapas, pausada pelo orçamento. Aumente ou remova o orçamento, ou espere a redefinição diária, e depois retome.

Ambos os orçamentos contam o seu dia local, e ambos incluem o gasto das missões: o orçamento de um projeto conta os turnos fixados a esse projeto, o de todo o app conta todos os turnos. "Hoje" significa o seu dia local em todo o app, na barra de estado, em Analytics e nos limites. O alerta de custo por job é uma configuração separada.

**Limites semanais, mensais e por execução.** Os limites mais longos funcionam do mesmo jeito. Abra **Analytics → Orçamento** para definir um limite **semanal** e um **mensal**, por projeto e para o app inteiro, e um **limite flexível por execução** (*pausar e perguntar em $X*). As semanas começam na segunda-feira e os meses no dia 1, no seu horário local. Um limite semanal ou mensal pausa as filas, recusa inícios e deixa em pausa os loops em andamento exatamente como o orçamento diário; aumente-o ou remova-o ali, ou espere o reinício. Quando o custo informado de uma execução chega ao limite por execução, ela pausa, e **Retomar** pergunta se deve continuar sem o limite ou aumentá-lo. Atingir qualquer limite também adiciona um item **Aumentar limite** à lista **Pendências**.

O painel de Orçamento mostra hoje, esta semana e este mês em relação a cada limite. A **projeção** para o fim do mês é uma estimativa (a média dos últimos 14 dias completos vezes os dias restantes, mais o que você já gastou) e nunca é somada ao gasto faturado. **E se** recalcula os últimos 30 dias de uso de tokens registrado com outro modelo, pela tabela de preços do app, e diz *Sem preço* para um modelo sem preço. Em um plano de assinatura não há custo em dólares por uso, então o painel mostra turnos e limites do plano no lugar de dólares.
