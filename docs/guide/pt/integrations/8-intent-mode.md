# Intent: diga o problema, não a solução {#intent-mode}

Escrever código deixou de ser a parte lenta de construir software. O lento é saber o que construir e verificar que foi construído corretamente. O Intent parte daí. Você escreve o **intent**: o problema, o resultado que quer, como saberá que funcionou, quem e o que é afetado, os limites e o que ainda ninguém sabe. Você não escreve a solução. O Specrails deriva a spec do seu intent, e você revisa a spec em vez de escrevê-la.

A partir de um intent há dois caminhos iguais:

- **Explorar**: construa junto com um agente numa sessão de Intent isolada (o próprio branch, uma cópia à parte do seu projeto). Quando o resultado estiver certo, um rail deriva a spec do que você construiu.
- **Delegar**: o agente escreve a spec a partir do intent, você a revisa e um rail a constrói.

Explorar serve para descobrir; Delegar, para construir o que já está claro. Nenhum é recomendado: quem escolhe é você.

## O intent

Um intent tem seis partes, e nenhuma para a solução:

| Parte | O que leva |
| --- | --- |
| **Problema** | O que está errado hoje, para quem e quando dói. |
| **Resultado buscado** | O que é verdade quando está resolvido. Uma **hipótese** opcional se lê *Acreditamos que … vai produzir …; saberemos que funcionou quando …*. |
| **Como saberemos** | Sinais observáveis de que o resultado aconteceu («um usuário novo conclui a configuração em menos de 2 minutos»). Eles viram critérios de aceitação. |
| **Quem e o que é afetado** | Pessoas, telas ou sistemas. |
| **Restrições** | Limites que qualquer solução deve respeitar. |
| **Perguntas em aberto** | O que ainda ninguém sabe. Os agentes as investigam em vez de adivinhar. |

Se você citar uma solução («adicionar um cache Redis»), o intent guarda para que ela serve («a API responde em menos de 200 ms») como resultado buscado, e a sua solução vira uma restrição (você a exige) ou uma pergunta em aberto (é uma opção).

Toda spec pode ter um intent. Ele fica acima da descrição no detalhe da spec, onde você pode editar cada parte; uma spec sem intent mostra uma ação compacta **Adicionar intent**. Enquanto você edita, **Salvar intent** é o botão principal, **Esc** cancela e **⌘/Ctrl+Enter** salva. Cada pergunta em aberto respondida mostra a resposta sob o rótulo **Resposta** e, quando não resta nenhuma em aberto, o título passa a **Perguntas · N respondidas**. Uma spec cujo intent ainda tem perguntas em aberto mostra no board uma pequena bússola com o número delas, em qualquer visão do board (post-it ou linha). O intent fica no Specrails, como **Fora do escopo**, e nunca é escrito no Jira.

## De onde vem um intent

- **Numa missão (o padrão).** Quando você descreve um trabalho, o agente o entrevista como um analista. Pergunta sobre os usuários, os limites e como você saberá que funcionou, e mostra um cartão **Intent** com cada parte e duas leituras do seu pedido. Clique numa leitura para responder, ou responda com as suas palavras. Enquanto o intent não está acordado, cada pergunta em aberto do cartão é um botão que preenche a sua resposta no compositor, e uma pílula diz quantas ainda estão abertas. Quando ele é acordado, a pílula mostra **Acordado**, as leituras dão lugar a **Leitura confirmada** e o cartão oferece **Explorar** e **Delegar** lado a lado sob **Como você quer continuar?**; os dois caminhos continuam no cartão mesmo depois das suas próprias mensagens seguintes, e um intent longo é encurtado com **Ver o intent completo**. O chip **Começar por um problema** na tela inicial da missão inicia essa entrevista. Uma spec que o agente escreve a partir dele leva o intent automaticamente. Para pular a etapa do intent numa missão, envie `#noframe`; `#frame` a reativa.
- **Em Adicionar spec.** **Intent** é o primeiro modo e abre por padrão (marcado como **Padrão**). Descreva o problema, não a solução; três chips acima do editor, **Problema**, **Quem afeta** e **Como saberemos**, inserem uma linha para preencher (*Problema:*, *Quem afeta:*, *Saberemos que funcionou quando:*). Clique em **Escrever o intent e uma spec**: uma única passada de IA escreve o intent e depois a spec derivada dele, pronta para você revisar. Quick, Explore e Raw continuam lá. Se o intent não puder ser escrito, você ainda recebe a spec, sem intent, e um aviso informa isso; se a geração falhar, o seu texto continua no editor. Uma spec **Raw** agora não recebe intent: você pode adicioná-lo depois a partir da spec.

## O intent acompanha o trabalho

- Todo agente que trabalha na spec recebe primeiro o intent, marcado como fonte de verdade do *porquê* e do *resultado buscado*, nunca do *como*. Isso inclui o planejador, o desenvolvedor, o revisor e o agente da sessão de Intent. O revisor também avalia o trabalho em relação ao resultado buscado e aos sinais.
- Quando um rail entrega uma spec que tem intent, o Specrails o escreve como `intent.md` na mudança do OpenSpec da execução, ao lado da proposta, do design e das tarefas. Assim o intent fica no Git junto com o código. (Uma execução em lote que abrange várias specs não escreve nenhum.)

## Explorar: iniciar uma sessão de Intent

Escolha **Explorar** num cartão de intent acordado. Abre-se uma confirmação, **Explorar com o agente**: o Specrails cria uma cópia à parte do projeto no próprio branch do Intent, onde o agente pode escrever código, e seu branch principal não é alterado. Clique em **Começar a explorar**. No board aparece uma spec provisória com o seu intent e a etiqueta **Em Intent** (clique nela para voltar à missão), e o primeiro turno do agente parte do intent.

## Começar um Intent a partir de uma spec existente

Qualquer spec pode ser construída em Intent, não só uma ideia nova. Intent e Implement continuam sendo duas formas iguais de trabalhar nela:

- no quadro, clique com o botão direito numa spec e escolha **Explorar com o agente** (ao lado de arrastá-la para um rail); no detalhe da spec, **Explorar com o agente** fica ao lado de **Mover para um rail**;
- numa missão, quando você pede para implementar uma spec sem citar um rail, o agente mostra um cartão de dois caminhos para essa spec sob **Como você quer continuar?**: **Explorar** trabalha nela com você e **Delegar** a lança num rail;
- um cartão de lançamento em rail com uma única spec também oferece **Explorar com o agente** ao lado do lançamento.

As três portas abrem primeiro a mesma confirmação: o título da spec, um resumo do intent dela, o motor que vai trabalhar e, só num projeto com vários repositórios Git, um seletor **Repositório** (apenas repositórios Git; o repositório da spec, ou, se não houver, o principal, vem pré-selecionado; as setas mudam a escolha). Nada começa até você clicar em **Começar a explorar**; **Cancelar** deixa a spec como estava. Pelo menu do quadro, o detalhe da spec abre com essa confirmação por cima. Quando o Intent começa, a missão vem para a frente e um aviso diz **Explorando a spec #N em <branch>** com **Abrir a missão do Intent**. O branch do Intent recebe o nome da spec em palavras inteiras, até 48 caracteres, nunca cortado no meio de uma palavra (`feat/1-alta-sin-clave-de-api-proyecto`).

A própria spec fica **Em Intent**: nenhuma spec provisória é criada e o primeiro turno do agente recebe a spec (primeiro o intent e depois os critérios de aceitação, Contract Layer, itens fora do escopo e addenda abertos). Iniciado pelo quadro, o Intent abre na missão da própria spec ou numa missão nova com o nome da spec. Uma spec que já está em Intent oferece, em vez disso, **Abrir a missão do Intent**, e o cartão post-it deixa de oferecer **Mover para um rail**. **Explorar com o agente** fica desativado, com o motivo ao passar o mouse, quando a spec está concluída ou cancelada, está num rail ou o Intent não está disponível.

**Descartar** devolve a spec exatamente como estava, com o status anterior: sua spec nunca é apagada. Quando o Intent é entregue, a spec é reescrita a partir do que foi construído e, antes, o texto original fica guardado como comentário, **Original spec before Intent**, para que nada se perca. O intent em si nunca é reescrito: apenas as suas perguntas em aberto ganham as respostas que o trabalho resolveu. Uma spec já vinculada ao Jira atualiza a mesma issue e a move para o status mapeado para revisão; nenhuma segunda issue é criada.

## Enquanto você está em Intent

O modo Intent aparece onde você olhar, com a cor própria do Intent: o compositor mostra um chip **Intent** ao lado do de autonomia e a dica *Diga ao agente o que mudar neste Intent…*; o título da missão indica **Em Intent**, assim como a linha dela na lista de missões. A conversa marca onde você entrou e saiu do Intent, e as respostas do agente escritas em Intent levam uma pequena marca **Intent** ao lado do horário.

A faixa logo acima do compositor mostra o Intent em uma linha curta: o estado, **Explorando · 7 arquivos**, **Pausar** e **Passar a um rail**. **Passar a um rail** está sempre lá e vira a ação principal, preenchida, assim que houver arquivos alterados no branch do Intent; antes disso, o rail ainda consegue derivar a spec da sua conversa. Quando uma ação não está disponível (o Intent ainda está salvando, há outra ação em andamento), passar o mouse sobre ela explica o motivo. Abra a linha pela seta, como qualquer outra execução, para ver o resto:

- o **branch** (clique para copiar o nome), as **alterações** com as linhas adicionadas e removidas (clique para listar cada arquivo alterado com o estado e os +/−) e o **custo até agora**, conforme cobrado pelo provedor. Mostra `—` até que um turno tenha custo informado, e nunca uma estimativa; um `*` indica um total que deixa de fora turnos sem preço, com uma nota dizendo quantos;
- **Pré-visualizar** enquanto a app do Intent estiver rodando (veja abaixo);
- **Descartar**, separado, apaga as alterações do Intent, o branch dele e a spec provisória. A confirmação lista o que você perde: os arquivos alterados com os +/−, o branch e a spec.

**Pausar** para o agente e mantém suas alterações e a spec. A linha passa então a mostrar **Retomar**.

Você pode escrever enquanto o agente trabalha: no Intent, sua mensagem **interrompe** a etapa atual (o botão de enviar vira um raio) e o agente continua na hora com a nova informação. Enquanto o Intent está aberto, a faixa de git abaixo do compositor sai do caminho: o painel do Intent já mostra o branch dele.

## Experimentar a app

O próprio agente do Intent roda o typecheck e os testes para verificar o trabalho. Quando há algo para experimentar, ele pergunta com três opções: **Start the app**, **Start and expose on the local network** ou **Not now**. Expor a app permite abri-la em um celular na mesma Wi-Fi ou VPN, e qualquer pessoa nessa rede pode acessá-la.

Quando a app está no ar, o agente passa os endereços como links e o painel do Intent mostra **Pré-visualizar** com um ponto verde: abre a app no seu navegador. O menu tem o endereço de rede e **Parar app**. A app roda a partir da cópia do Intent, nunca do seu checkout principal, e o Specrails a encerra quando você pausa, descarta ou entrega o Intent.

## Passar a um rail {#intent-hand-off}

Quando estiver satisfeito com o resultado, clique em **Passar a um rail**. A linha passa a mostrar **Pronto para virar uma PR** e abre uma única linha acima: *Rail 2 vai transformar seus 7 arquivos alterados em uma PR revisada. Se falhar, seu trabalho fica a salvo.* Clique em **Lançar**, ou em **Ainda não** para voltar ao Intent; **Esc** equivale a **Ainda não**; um clique fora só recolhe a linha, e a faixa continua em **Pronto para virar uma PR** com **Lançar**. Se o motor da sua conversa não puder fazer a passagem a um rail nesta máquina, uma nota logo abaixo da linha avisa e o motor padrão do rail é usado.

O rail, o motor, o modelo e o esforço já vêm escolhidos (um rail livre e o motor da sua conversa). Para mudá-los, abra **Ajustar opções**; ali você também vê o que mudou. O custo até agora aparece na linha principal. Suas escolhas são mantidas se você clicar em **Ainda não** e passar a um rail mais tarde. Enquanto a passagem a um rail é iniciada, a faixa mostra o lançamento sem lacunas e depois acompanha a execução etapa por etapa. Se o limite de revisão ou um orçamento for atingido, a linha avisa e nada é lançado. Se a execução não aparecer em 45 segundos, a faixa para de girar e mostra **Ainda passando a Rail 2…** com **Atualizar**, que verifica de novo e continua esperando até a execução aparecer.

O rail deriva a spec e a respectiva mudança de spec a partir do que você construiu, verifica e revisa, e o cartão de entrega aparece na missão como em qualquer execução.

Se a execução falhar por um motivo técnico, o trabalho volta sozinho para este Intent, intacto: o cartão diz em palavras simples o que falhou (os códigos ficam em **Detalhes técnicos**) e o agente recebe o erro e o explica. Se a revisão pedir alterações, o cartão oferece **Voltar ao Intent** ou **Relançar**. Quando a entrega se conclui, a missão fecha o Intent com um resumo: o pull request, a spec reescrita a partir do que você construiu, a mudança de spec arquivada e a issue do Jira, se houver.

## Bom saber

- O Intent só escreve no próprio branch. Fora do Intent, as missões continuam somente leitura.
- Um Intent por missão de cada vez. A pausa sobrevive a uma reinicialização da app.
- Se a cópia do projeto do Intent desaparecer, o Intent fica marcado como **precisa de revisão** (só para informação, nada a decidir) e nada é apagado.
- A faixa nunca troca a execução que você está vendo. Se outra passar a precisar de você nesse meio-tempo, o nome dela no seletor da faixa mostra **precisa de você**.
- O Jira não recebe nada enquanto você está em Intent nem se você o descartar.
- O custo do Intent aparece em Análises como uma superfície própria, **Intent**, e dentro do bloco de missões do agente.
