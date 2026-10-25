# Specs e o backlog {#specs-backlog}

Uma **spec** é a unidade de trabalho que o pipeline de IA implementa. Pense nela como um ticket: um título, uma descrição do que quer fazer, uma prioridade e, opcionalmente, etiquetas. Quando lança o pipeline, os agentes de IA leem a spec e agem sobre ela — por isso, uma spec clara é o input mais importante para um bom resultado.

Por vezes, na app, as specs também são chamadas de **tickets** — as duas palavras significam o mesmo.

## O quadro

Cada projeto abre no seu **Dashboard**, que mostra a **SpecsBoard** — a lista de todas as specs do projeto. Este é o seu backlog. É aqui que cria novas specs, define a sua prioridade, as arrasta para um rail para as implementar e vê o seu estado mudar à medida que o trabalho avança.

O quadro tem dois modos de visualização, alternados a partir de um botão na barra de ferramentas e memorizados por projeto:

- **Vista de post-its** (a predefinida) — mosaicos em forma de cartão com resumos curtos.
- **Vista de lista** — linhas compactas de uma só linha.

A barra de ferramentas das Specs tem duas linhas. A primeira reúne um campo de **pesquisa** (prima `/` para lá chegar; procura no título, `#número`, etiqueta ou chave do Jira), um único botão **Filtros**, os controlos de ordenação e vista, e **Nova spec**. A segunda linha é o **seletor de estados**: cada estado como um segmento próprio com contagem em direto, mais dois grupos inteligentes, **Ativas** (a predefinição: tudo o que ainda está em movimento, ou seja rascunhos, por fazer, em curso e em revisão) e **Todos** (tudo, com Concluído fixado no fundo). Quando a coluna é estreita, os estados menos usados recolhem-se num menu **Mais**, e o estado escolhido fica sempre visível. A sua escolha é lembrada por projeto e espelhada no URL, pelo que um refresh ou um link partilhado restaura a vista exata. **Filtros** abre um único painel com uma secção por dimensão: **etiquetas** (seleção múltipla) e, em projetos ligados ao Jira, **épico**, **sprint** e **estado Jira** (os estados *reais* do fluxo do quadro, p. ex. "Code Review", agrupados sob o estado a que mapeiam e combinados com o seletor de estados). Enquanto uma pesquisa ou um filtro restringe o quadro, uma terceira linha mostra cada um como um chip removível, indica "x de y" specs e oferece **Limpar tudo** (que mantém o estado escolhido). Ordene por **Predefinida**, **Ticket #** ou **Prioridade**, cada uma com um seletor ascendente/descendente.

### Selecionar várias specs

Faça a triagem em lote em vez de uma spec de cada vez. Pressione `x` em um cartão em foco, clique em um cartão com `Ctrl`/`⌘` ou clique com `Shift` para selecionar um intervalo (um intervalo fica dentro de uma coluna: as specs ativas ou o grupo Concluído). `Ctrl`/`⌘`+`A` seleciona toda a coluna em que você está e `Esc` limpa a seleção. Cada cartão mostra uma caixa de seleção ao passar o mouse ou receber foco, e os cartões selecionados têm a borda destacada. Nenhuma dessas teclas age enquanto você digita no campo de busca.

Assim que uma spec é selecionada, uma barra flutuante aparece na parte inferior do quadro com a contagem e as ações:

- **Mover para** muda o estado. As specs locais recebem os estados locais; as que vêm do Jira recebem os estados reais do fluxo do quadro do Jira e passam pela mesma fila do Jira que um movimento individual.
- **Etiqueta** adiciona uma etiqueta à seleção, ou remove uma que as specs já tenham.
- **Prioridade** define uma mesma prioridade para todas.
- **Adicionar a um rail** coloca a seleção em um rail.
- **Lançar tudo** dá a cada spec selecionada seu próprio rail livre e as inicia em paralelo, após a mesma confirmação e verificação do orçamento diário do *Lançar tudo* dos rails. Specs que ainda não podem ser lançadas (por exemplo, em revisão sem PR aberta) ou que não encontram um rail livre são ignoradas e contadas no resumo.
- **Excluir** envia as specs para *Excluídas recentemente*.
- **Limpar** (ou `Esc`) descarta a seleção.

Excluir e alterar estado, etiquetas ou prioridade podem ser desfeitos em uma única etapa: um só aviso *Desfazer* (ou `⌘Z`) restaura todas as specs alteradas. Se algumas falharem, um único aviso diz quantas deram certo e quantas não. A seleção só contém specs que você vê: um filtro que oculta uma spec selecionada a tira da seleção.

### Visões salvas

O botão **Visões**, ao lado de **Filtros**, salva o quadro como está agora: o seletor de estado, os filtros, a ordenação e a densidade (não o texto da busca). Escolha **Salvar a visão atual…**, dê um nome («Prontas para lançar», «Sprint 42», «Falhas desta semana») e escolha-a depois no mesmo menu. **Gerenciar visões…** renomeia uma visão, atualiza-a com o quadro como está, copia o link ou exclui. As visões pertencem ao projeto. Um link copiado (`?view=…`) aplica a visão quando aberto neste aplicativo, e a paleta de comandos (`⌘K`) pode salvar a visão atual ou trocar para outra.

## Estados

Uma spec percorre um pequeno conjunto de estados. O quadro dá a cada um uma pista visual consistente para que possa ler o estado do seu backlog de relance:

| Estado | O que significa |
|--------|---------------|
| **Rascunho** | Uma ideia em curso guardada a partir de uma conversa do modo Explore. Ainda não está pronta para implementar — pode voltar e continuar a dar-lhe forma. Mostra uma etiqueta `Draft`. |
| **Por fazer** | Pronta para ser executada. É aqui que uma spec terminada aterra quando a cria. |
| **Em curso** | O pipeline está a trabalhar nela neste momento (um ponto azul pulsante). |
| **Em revisão** | Implementada — cada execução terminada estaciona aqui as suas specs para a sua aprovação: faça merge da PR em rascunho ou mova-as você mesmo (uma etiqueta âmbar). |
| **Concluído** | Aprovada — a PR foi integrada, ou moveu-a você mesmo para aqui (um visto verde). |
| **Cancelado** | Abandonada (um X vermelho). |

Os rascunhos vivem no mesmo grupo ativo que as specs Por fazer — não há uma coluna separada para eles — mas têm um contorno subtilmente colorido e uma etiqueta `Draft` para serem fáceis de identificar. Veja [Rascunhos e o Contract Layer](drafts-and-contract-layer.md) para a história completa sobre rascunhos.

## Prioridades

Cada spec que não seja um rascunho tem uma prioridade: **Crítica**, **Alta**, **Média** ou **Baixa**. A prioridade é apenas uma ferramenta de organização — ajuda-o a decidir o que implementar a seguir e permite-lhe ordenar o quadro. Define-a ao criar uma spec e pode alterá-la a qualquer momento clicando com o botão direito no cartão da spec e escolhendo **Definir prioridade**.

Os rascunhos são a única exceção: um rascunho pode *não* ter prioridade nenhuma, porque ainda é uma ideia em curso. A prioridade fica fixada quando confirma o rascunho numa spec a sério.

## Criar uma spec

Para criar uma spec, clique em **Nova spec** (o botão Mais na barra de ferramentas da SpecsBoard). Abre-se a janela **Adicionar Spec** com algumas formas de trabalhar:

- **Quick** — descreve o que quer e a IA escreve a spec completa de uma só vez. Veja [Adicionar Spec — modo Quick](add-spec-quick-mode.md).
- **Explore** — conversa com a IA, e ela ajuda-o a dar forma à spec turno a turno. Veja [Adicionar Spec — modo Explore](add-spec-explore-mode.md).
- **Raw** — o que quer que escreva é guardado tal e qual como uma spec, sem qualquer IA envolvida. Use este modo quando já tem o texto da spec pronto.

Qual escolher depende do quão clara já está a ideia. Sabe exatamente o que quer? Quick. Ainda a pensar nela? Explore. Já tem o texto? Raw.

## Adendos: iterar sobre uma spec existente

Quando uma spec já tem trabalho por trás — uma PR em revisão, uma funcionalidade integrada — e quer *mais*, não reescreva a descrição: isso desvirtua a spec (e sincroniza o desvio com o Jira) e obriga a próxima execução a replanear tudo. Abra a spec e adicione um **adendo**: uma nota curta com um tipo (pedido de alteração, feedback de revisão, esclarecimento, restrição) e as suas palavras. Os adendos abertos seguem automaticamente com o próximo lançamento dessa spec em qualquer loop — Implement, SDD Quick, Freestyle — para que a execução altere apenas o que pediu, e o pacote de revisão reporta cada um como aplicado, parcialmente aplicado ou bloqueado. Se a execução falhar ou descartar a entrega, voltam sozinhos a **Aberto**. O agente de missão pode adicioná-los por si quando lhe pede para alterar algo numa spec existente.

## Revisar uma entrega: o que olhar primeiro

Quando uma execução termina, o pacote de revisão abre com **O que olhar**: o resumo curto do revisor de IA com os pontos mais arriscados primeiro (alto, depois médio, depois baixo, cada um com arquivo e linha), o comportamento que muda, as regras em que a mudança se apoia, os caminhos de código que nenhum teste exercita e as verificações que só uma pessoa pode fazer. Os mesmos riscos, caminhos sem teste e verificações aparecem num bloco curto no topo da pull request, e o card da missão mostra o principal risco em uma linha. O resumo orienta a revisão, não é um resultado de verificação: nunca bloqueia Aceitar. Execuções feitas com um Specrails Core anterior não têm resumo e o pacote continua igual.

## Desfazer e Excluídos recentemente {#recently-deleted}

Excluir uma spec, movê-la para outro estado, mudar suas etiquetas ou tirá-la de um rail acontece na hora — sem um "Tem certeza?" antes. Em vez disso, um aviso oferece **Desfazer** por cerca de oito segundos, e **⌘Z** (**Ctrl+Z** no Windows e no Linux) faz o mesmo enquanto você não estiver digitando em um campo. Desfazer é por projeto: trocar de projeto encerra a janela.

Uma spec excluída (e uma missão excluída) não desaparece. Ela vai para **Configurações → Excluídos recentemente**, nas configurações do projeto, onde você pode **Restaurá-la** por 30 dias ou **Excluí-la definitivamente**, o que pergunta antes. Depois de 30 dias ela é removida de vez. Descartar trabalho não enviado, fechar à força uma pull request e remover um projeto continuam perguntando antes, porque não podem ser revertidos. Uma spec ligada ao Jira continua sendo movida com **Mover para**, em vez de excluída.

## Para onde ir a seguir

- [Adicionar Spec — modo Quick](add-spec-quick-mode.md) — a forma mais rápida de transformar uma ideia numa spec.
- [Adicionar Spec — modo Explore](add-spec-explore-mode.md) — dê forma a uma spec em conversa.
- [Rascunhos e o Contract Layer](drafts-and-contract-layer.md) — guarde trabalho em curso e enriqueça specs para o pipeline.
