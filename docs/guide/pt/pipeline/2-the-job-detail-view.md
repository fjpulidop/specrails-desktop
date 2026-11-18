# A vista de detalhe do job

Clique em qualquer cartão de job na página **Jobs** e chega aqui: o cockpit de uma única execução de rail. Foi construída em torno de uma promessa — **os números ao vivo que vê são reais, nunca estimativas.** Esta página percorre as fases, as métricas ao vivo, os cartões de spec — e o compositor que lhe permite **falar com o job em execução**.

## O layout

O cabeçalho compacto mantém estado, duração, fase, ações e chips do pipeline. Logo abaixo, **uma única linha de navegação** reúne tudo o que pode consultar:

- **Motivos da falha** — presente numa execução falhada ou cancelada com diagnóstico, e selecionado primeiro. Uma pergunta pendente que possa ser respondida também o disponibiliza: clique no botão da pergunta no cabeçalho para abrir Detalhes e responder, mesmo sem diagnóstico.
- **Grafo de execução** e **Detalhe do registo** — nas execuções de loop, o grafo do workflow e o registo passo a passo.
- **Registo** — nos jobs simples, o log em streaming.

O painel limitado **Detalhes** (valores reais e controlos de execução) fica junto de Motivos da falha quando esse separador existe, e junto do log caso contrário. A secção do log que escolheu por último e se Detalhes está expandido são memorizados separadamente para a página e para a janela da missão; o separador selecionado reinicia em cada visita. O compositor permanece abaixo das evidências.

Na app de desktop, um job aberto a partir de uma missão aparece **na sua própria janela**, uma janela por job. Carregue em **Escape** ou feche a janela para voltar; a versão de browser mostra o mesmo conteúdo num modal.

## Fases do pipeline

Para os jobs `Implement`, a execução percorre as fases definidas pelo slash command — por default:

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

Que agente trata de cada fase é decidido pelo **perfil de agentes** do projeto. O trio base (`sr-architect`, `sr-developer`, `sr-reviewer`) está sempre presente; as regras de encaminhamento de um perfil podem acrescentar agentes ou trocar qual deles corre uma fase. A barra de progresso das fases só aparece quando o comando define mesmo fases — os jobs que ignoram o pipeline (como um loop Freestyle da galeria) não mostram nenhuma.

## Métricas ao vivo — honestas por princípio

O cabeçalho compacto mostra estado, duração, atividade, passos e ações. Os valores reais e os controlos de continuação estão em **Detalhes**, num painel limitado:

| Métrica | Quando vê o valor real |
|--------|------------------------------|
| **Duração** | **Ao vivo.** Um contador de 1 segundo vai subindo enquanto o job corre — este é o único número genuinamente ao vivo. |
| **Turnos** | Derivados incrementalmente dos eventos de assistant transmitidos à medida que chegam. |
| **Tokens** | Agregados incrementalmente a partir do mesmo stream (tolerante a eventos sem campos de uso). |
| **Custo** | Mostrado como `—` até o job terminar, e depois revelado como o valor autoritativo `total_cost_usd`. |

O princípio de design: **nada de números aproximados ou estimados a meio da execução.** A duração é real porque não passa de um relógio. Turnos e tokens são acumulados a partir de atividade realmente transmitida. O custo *não* é estimado de propósito durante a execução — aparece como pendente e só passa ao seu valor final e autoritativo quando o fornecedor o reporta na saída do job. Se um número parecer estar à espera, é intencional — está a ver a verdade, não uma projeção.

A etiqueta e o ícone do cabeçalho correspondem ao estado do job, e o painel é renderizado para jobs `running`, `completed` e `failed` por igual — por isso a vista de detalhe de um job terminado mostra as mesmas métricas congeladas nos seus valores finais.

## Os cartões de spec

O **cabeçalho de specs** fica entre o cabeçalho de estado e o log. É um cartão de identidade premium que mostra um chip por cada spec que o job tocou — correspondidas a partir do comando lançado, por isso reflete exatamente quais as specs de que esta execução tratou.

- **2–3 specs** — mostradas como uma lista de chips.
- **4 ou mais** — colapsam num modo compacto `+ N more` com um chevron para expandir, para o cabeçalho ficar arrumado.

Clicar num chip abre o detalhe dessa spec **por cima da página do job** — não perde o seu lugar nem muda de rota. É uma forma rápida de reler o que um job deve entregar enquanto o vê trabalhar. (Em ecrãs com largura de tablet pode até arrastar uma modal de spec para o lado e comparar duas specs lado a lado.)

## O log em streaming

Abra **Registo** (jobs simples) ou **Detalhe do registo** (execuções de loop) para o log em streaming, ou escolha Story quando a narração estiver ativa. A saída chega em tempo real por WebSocket:

- **Auto-scroll** mantém o output mais recente à vista (faça scroll para cima e pausa, para poder ler).
- **Pesquisa** para saltar para uma frase.
- **Copiar** para agarrar o log inteiro.

Esta é a verdade crua do que a IA está a fazer — cada chamada de ferramenta, cada edição de ficheiro, cada execução de teste.

## Execuções de loop: o grafo e o registo de passos

Numa **execução de loop** (ver [O Loop Builder](the-loop-builder)), dois separadores mostram as evidências.

**Grafo de execução** é o workflow tal como correu. Está sempre expandido e acompanha o passo em execução, ou o que falhou:

- **O caminho percorrido é sólido.** Os passos por onde a execução passou são desenhados a cheio; os que nunca alcançou ficam tracejados e esbatidos. Ative **Só o caminho percorrido** para ocultar o resto. A legenda fica em linha.
- **Inspecionar um passo.** Selecione um nó para listar as suas tentativas com o estado e a duração. Clique numa tentativa para abrir o seu log em Detalhe do registo. **Repetir a partir daqui** fica na linha de cada tentativa terminada, para que uma execução ligada comece exatamente na tentativa que escolheu. Os ids técnicos estão em **Rastreio**.

**Detalhe do registo** reúne o rasto de passos e o log, e abre no passo que falhou:

- **A faixa de passos** no topo lista apenas os passos que a execução alcançou, por ordem, com um contador de iterações (`Iteração 3/10`) à direita. Os chips ficam esmaecidos enquanto esperam, pulsam enquanto correm, e depois mostram um visto ou uma cruz; o chip de um Decisor mostra ainda o veredicto pelo qual encaminhou. Clique num chip para saltar para esse passo.
- **Uma caixa recolhível por passo.** Cada passagem por um nó vira a sua própria secção, com o número do passo, o nome, um selo de iteração, a duração ao terminar — e o seu próprio botão de copiar, para levar exatamente a saída de um passo. (O copiar da barra de ferramentas continua a levar o log inteiro.) Tudo o que foi impresso antes do primeiro passo — o banner de arranque, o aviso de worktree — fica arrumado numa secção de **Preparação**.
- **O modo de acompanhamento** vem ligado por defeito: o passo em execução permanece aberto e com auto-scroll enquanto os anteriores se recolhem. No momento em que sobe o scroll ou abre um passo antigo, o acompanhamento pausa para poder ler — uma pílula flutuante **Retomar acompanhamento** devolve-o ao direto. **Expandir tudo / Recolher tudo** vivem na barra de ferramentas, e escrever na pesquisa procura em todos os passos ao mesmo tempo.
- **Os passos interrompidos também são honestos.** Um passo que nunca chegou a reportar o seu desfecho — a execução foi cancelada ou a app fechou a meio do passo — é marcado como **Interrompido** com uma borda tracejada, em vez de fingir que terminou.

A Story, quando a narração está ativa, é oferecida dentro de Detalhe do registo. A exploração do grafo e a posição pausada do log são preservadas ao mudar de separador.

## Fale com o job em execução

Todo job Claude corre por omissão como uma **sessão ao vivo**, por isso um compositor de chat fica ao fundo desta página — e do modal de job no modo missão. Use-o para fazer uma pergunta ao agente em execução («porque é que aquele teste falhou?») ou para o orientar a meio da execução («salta o refactor, concentra-te no fix»).

Algumas coisas que vale a pena saber:

- **As mensagens entram em fila, não interrompem.** Envie enquanto o agente está a transmitir e a sua mensagem espera a vez — corre como o prompt seguinte, e o job continua a seguir o seu plano. Um pequeno contador mostra quantas mensagens estão em fila.
- **A linha de totais é real.** O compositor mostra um resumo ao vivo `N turnos · $X`, somado a partir do uso real de cada turno concluído — coerente com a promessa desta página de nunca adivinhar.
- **Duas formas de uma sessão terminar.** A maioria dos jobs **termina sozinha**: assim que um turno acaba sem mensagens em fila, a sessão assenta e o job conclui — as suas mensagens são orientação opcional, nunca uma obrigação. Uma ação discreta **Concluir agora** termina-a mais cedo com tudo o que foi produzido até então. Os jobs **Freestyle** antigos (de antes de o Freestyle passar a ser um loop da galeria) são a exceção: ficam à espera entre turnos até que clique em **Finalize** — é esse o seu desenho, uma sessão de ida e volta que fecha quando terminar.
- **Nas execuções de loop, as mensagens vão para o passo ativo.** Num loop embutido ou personalizado, a sua mensagem chega ao **passo de IA que está a correr nesse momento**. Entre passos (enquanto o Loop Decider pensa, ou um comando de shell corre) o compositor mostra um breve estado *«À espera do próximo passo…»* — o texto rascunhado mantém-se, e o envio reativa-se quando o próximo passo de IA arranca. **Assentar este passo** termina o passo atual mais cedo e deixa o loop avançar com o que ele produziu.

## Exportação de diagnóstico

Se a [telemetria](../settings/pipeline-telemetry-and-diagnostics) estava ativada para o job, aparece um botão **Exportar diagnóstico** no cabeçalho. Descarrega um ZIP que contém:

- `job-metadata.json` — comando, estado, perfil, plugins.
- `telemetry.ndjson` — sinais OTLP/JSON não comprimidos.
- `logs.txt` — o log completo em streaming.
- `summary.md` — destaques legíveis por humanos.
- `profile.json`, `plugins.json` — snapshots exatos do que correu (quando presentes).

Útil para partilhar uma execução com um colega de equipa, ou para abrir um relatório de bug preciso.

## Quando uma execução falha

Nos jobs falhados ou cancelados com diagnóstico, **Motivos da falha** abre com o **cartão de diagnóstico**, que explica a causa e porque aconteceu, quando se sabe. Quando o runtime registou que passo falhou, o cartão indica-o: o passo, a tentativa, a iteração e a hora. As causas:

- **Testes falharam**: as verificações continuam falhando após as rodadas de correção.
- **Limite do fornecedor** — foi atingido o limite de utilização do fornecedor de IA. O cartão diz quando é reposto, na tua hora local quando o fornecedor indicou a hora exata, senão nas palavras do fornecedor. Uma execução ainda em pausa no limite mostra o seu próprio cartão: quando retoma sozinha, **Retomar agora** e **Continuar agora com** outro fornecedor. Vê [Limites de utilização](1-rails-and-jobs.md#usage-limits).
- **Ambiente**: a máquina não consegue executar as verificações (credenciais, uma ferramenta ausente, um comando de preparação que falha). *Corrigir o ambiente* mostra exatamente o que executar ou mudar.
- **Porta em uso**: a verificação ou o servidor da própria execução não pôde iniciar porque outro processo já ocupava sua porta (`EADDRINUSE`). Não conta como testes falhos. Cada worktree de execução recebe portas próprias por `PORT` e `SPECRAILS_RUN_PORT_RANGE_START`/`_END`; um projeto que lê `PORT` nunca colide. Pare o outro processo, ou faça o projeto ler `PORT`, e depois **Executar novamente**.
- **Bloqueada**, **sem tempo**, **em silêncio** e **parou inesperadamente** nomeiam o limite ou o processo que interrompeu a execução.
- **Causa desconhecida**: o app não adivinha. Mostra o fim do registro para você mesmo ler.

Sob o diagnóstico há até três remédios ordenados, e só os que podem funcionar aqui: **Retomar a partir de** a fase que parou, **Executar novamente**, **Editar a spec e relançar** (os adendos da spec levam sua mudança para a próxima execução), **Corrigir o ambiente** e **Abrir o registro na falha**. A mesma causa aparece como um rótulo de uma linha na [lista de pendências](../getting-started/the-dashboard-tour), e o cartão de execução da missão mostra o mesmo cartão.

### Análise de IA {#ai-failure-analysis}

Por baixo do cartão, uma **Análise de IA** lê o log e explica porque a execução parou: a causa, **O que fazer**, e as linhas **Do log** em que se baseou, citadas palavra por palavra. Corre com o mesmo fornecedor e modelo que executaram o job, por isso a sua conta consegue sempre executá-la. Arranca sozinha, exceto quando a causa foi o limite do fornecedor; nesse caso carregue em **Analisar com IA**. A análise fica guardada com o job. Se o log mudar depois, ela indica-o e oferece **Analisar novamente**.

A análise está identificada como uma leitura de IA e nunca substitui o cartão: o diagnóstico, a sua causa e os seus remédios continuam a ser o que a app registou. Confira as linhas que cita antes de agir com base nela. O seu custo conta na categoria **Suporte** em [Analytics](../insights/analytics-and-cost-tracking).

## Para onde ir a seguir

- [Rails e jobs](rails-and-jobs) — lançar e enfileirar.
- [Acompanhar o custo](../insights/analytics-and-cost-tracking) — transformar os custos por job em analytics do projeto.

## Após reiniciar um workflow

Após uma falha, retome o workflow salvo com a configuração e os repositórios originais. Uma escrita interrompida exige selecionar a tentativa exata depois de revisar o diff do worktree. As etapas concluídas são preservadas. Uma chamada ao provedor cuja resposta foi perdida continua contabilizada como interrompida, com consumo desconhecido; nunca é apresentada como gratuita. Se os registros salvos não comprovarem a entrega original, a recuperação mostra um erro e preserva o worktree.

Quando uma etapa de decisão pausa para fazer uma pergunta, a retomada reutiliza a decisão salva e transmite a resposta humana à próxima etapa. O modelo não é chamado novamente para essa mesma decisão. Um prompt pausado pode precisar de outro turno do modelo para aplicar sua resposta.

## Retenção do histórico

As execuções guardadas são mantidas indefinidamente por omissão. Em **Execuções guardadas → Retenção do histórico**, um projeto pode mantê-las entre 1 e 3650 dias. Nada é eliminado em segundo plano: guarde a política, escolha **Pré-visualizar limpeza** e reveja cada execução e o seu motivo antes de **Eliminar histórico expirado**. Uma execução continua protegida enquanto está ativa, aguarda a sua resposta ou aprovação, tem uma escrita interrompida, uma entrega aberta ou um fork que ainda depende dela. Só é removido o histórico de execução no armazenamento Specrails do projeto; o repositório, os worktrees, o log do job e os registos de custo mantêm-se. Uma execução expirada aparece como **Expirado** e já não pode ser retomada nem bifurcada. As versões do Core ainda usadas por uma execução mantida são sempre preservadas.
