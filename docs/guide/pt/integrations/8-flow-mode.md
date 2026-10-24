# Flow: construir primeiro, spec depois

O Flow é uma forma de construir com um agente quando você ainda não sabe exatamente o que quer. Você conversa com o agente na sua missão, ele escreve e executa código de verdade no próprio branch do Flow (uma cópia à parte do seu projeto) e, quando o resultado estiver certo, você clica em **Passar a um rail**: um rail assume suas alterações, deriva a spec e executa a verificação, a revisão e a entrega de sempre.

O Implement serve para delegar um trabalho que você já sabe descrever. O Flow serve para descobri-lo.

## Como um Flow começa

Você nunca precisa pedir o Flow pelo nome. Quando você descreve algo exploratório ou visual ("quero experimentar…", "não sei como deve ficar"), a missão mostra um cartão com dois caminhos:

- **Flow**: construir junto com o agente agora; a spec vem no fim.
- **Spec + Implement**: combinar primeiro uma spec com o agente e depois passá-la a um rail.

Os dois caminhos têm o mesmo peso e aparecem sempre na mesma ordem: nenhum é recomendado, quem escolhe é você. Em **Por que o agente pergunta**, o agente explica em uma frase o que o levou a perguntar, e não insiste, seja qual for o caminho escolhido ou se você clicar em **Agora não**.

Escolher o Flow abre uma confirmação: o Specrails cria uma cópia à parte do projeto no próprio branch do Flow, onde o agente pode escrever código, e seu branch principal não é alterado. Clique em **Iniciar Flow**. No board aparece uma spec provisória com a etiqueta **Em Flow** (clique nela para voltar à missão).

Se o seu Specrails Core ainda não consegue executar o Flow, o botão fica desativado e o cartão lista o que falta. Normalmente basta atualizar o Specrails Core.

## Começar um Flow a partir de uma spec existente

Qualquer spec pode ser construída em Flow, não só uma ideia nova. Flow e Implement continuam sendo duas formas iguais de trabalhar nela:

- no quadro, clique com o botão direito numa spec e escolha **Começar em Flow** (ao lado de arrastá-la para um rail); no detalhe da spec, **Começar em Flow** fica ao lado de **Mover para rail**;
- numa missão, quando você pede para implementar uma spec sem citar um rail, o agente mostra o mesmo cartão de dois caminhos para essa spec: **Flow** trabalha nela com você e **Spec + Implement** a lança num rail;
- um cartão de lançamento em rail com uma única spec também oferece **Começar em Flow** ao lado do lançamento.

A própria spec fica **Em Flow**: nenhuma spec provisória é criada e o primeiro turno do agente recebe a spec (critérios de aceitação, Contract Layer, itens fora do escopo e addenda abertos). Iniciado pelo quadro, o Flow abre na missão da própria spec ou numa missão nova com o nome da spec. Num projeto com vários repositórios Git, quando a spec não indica exatamente um deles, um pequeno diálogo pergunta antes onde o Flow é executado: só aparecem os repositórios Git, o repositório da spec (ou, se não houver, o principal) vem pré-selecionado e as setas mudam a escolha. **Começar em Flow** fica desativado, com o motivo ao passar o mouse, quando a spec já está em Flow, concluída ou cancelada, está num rail ou o Flow não está disponível.

**Descartar** devolve a spec exatamente como estava, com o status anterior: sua spec nunca é apagada. Quando o Flow é entregue, a spec é reescrita a partir do que foi construído e, antes, o texto original fica guardado como comentário, **Original spec before Flow**, para que nada se perca. Uma spec já vinculada ao Jira atualiza a mesma issue e a move para o status mapeado para revisão; nenhuma segunda issue é criada.

## Enquanto você está em Flow

O modo Flow aparece onde você olhar, com a cor própria do Flow: o compositor mostra um chip **Flow** ao lado do de autonomia e a dica *Diga ao agente o que mudar neste Flow…*; o título da missão indica **Em Flow**, assim como a linha dela na lista de missões. A conversa marca onde você entrou e saiu do Flow, e as respostas do agente escritas em Flow levam uma pequena marca **Flow** ao lado do horário.

A faixa logo acima do compositor mostra o Flow em uma linha curta: o estado, **Flow · 7 arquivos**, **Pausar Flow** e a ação principal, **Passar a um rail**. Quando uma ação não está disponível (o Flow ainda está salvando, há outra ação em andamento), passar o mouse sobre ela explica o motivo. Abra a linha pela seta, como qualquer outra execução, para ver o resto:

- o **branch** (clique para copiar o nome), as **alterações** com as linhas adicionadas e removidas (clique para listar cada arquivo alterado com o estado e os +/−) e o **custo até agora**, conforme cobrado pelo provedor. Mostra `—` até que um turno tenha custo informado, e nunca uma estimativa; um `*` indica um total que deixa de fora turnos sem preço, com uma nota dizendo quantos;
- **Pré-visualizar** enquanto a app do Flow estiver rodando (veja abaixo);
- **Descartar**, separado, apaga as alterações do Flow, o branch dele e a spec provisória. A confirmação lista o que você perde: os arquivos alterados com os +/−, o branch e a spec.

**Pausar Flow** para o agente e mantém suas alterações e a spec. A linha passa então a mostrar **Retomar Flow**.

Você pode escrever enquanto o agente trabalha: no Flow, sua mensagem **interrompe** a etapa atual (o botão de enviar vira um raio) e o agente continua na hora com a nova informação. Enquanto o Flow está aberto, a faixa de git abaixo do compositor sai do caminho: o painel do Flow já mostra o branch dele.

## Experimentar a app

O próprio agente do Flow roda o typecheck e os testes para verificar o trabalho. Quando há algo para experimentar, ele pergunta com três opções: **Start the app**, **Start and expose on the local network** ou **Not now**. Expor a app permite abri-la em um celular na mesma Wi-Fi ou VPN, e qualquer pessoa nessa rede pode acessá-la.

Quando a app está no ar, o agente passa os endereços como links e o painel do Flow mostra **Pré-visualizar** com um ponto verde: abre a app no seu navegador. O menu tem o endereço de rede e **Parar app**. A app roda a partir da cópia do Flow, nunca do seu checkout principal, e o Specrails a encerra quando você pausa, descarta ou entrega o Flow.

## Passar a um rail

Quando estiver satisfeito com o resultado, clique em **Passar a um rail**. A linha passa a mostrar **Pronto para virar uma PR** e abre uma única linha acima: *Rail 2 vai transformar seus 7 arquivos alterados em uma PR revisada. Se falhar, seu trabalho fica a salvo.* Clique em **Lançar**, ou em **Ainda não** para voltar ao Flow; **Esc** equivale a **Ainda não**; um clique fora só recolhe a linha, e a faixa continua em **Pronto para virar uma PR** com **Lançar**. Se o motor da sua conversa não puder fazer a passagem a um rail nesta máquina, uma nota logo abaixo da linha avisa e o motor padrão do rail é usado.

O rail, o motor, o modelo e o esforço já vêm escolhidos (um rail livre e o motor da sua conversa). Para mudá-los, abra **Ajustar opções**; ali você também vê o que mudou. O custo até agora aparece na linha principal. Suas escolhas são mantidas se você clicar em **Ainda não** e passar a um rail mais tarde. Enquanto a passagem a um rail é iniciada, a faixa mostra o lançamento sem lacunas e depois acompanha a execução etapa por etapa. Se o limite de revisão ou um orçamento for atingido, a linha avisa e nada é lançado. Se a execução não aparecer em 45 segundos, a faixa para de girar e mostra **Ainda passando a Rail 2…** com **Atualizar**, que verifica de novo e continua esperando até a execução aparecer.

O rail deriva a spec e a respectiva mudança de spec a partir do que você construiu, verifica e revisa, e o cartão de entrega aparece na missão como em qualquer execução.

Se a execução falhar por um motivo técnico, o trabalho volta sozinho para este Flow, intacto: o cartão diz em palavras simples o que falhou (os códigos ficam em **Detalhes técnicos**) e o agente recebe o erro e o explica. Se a revisão pedir alterações, o cartão oferece **Voltar ao Flow** ou **Relançar**. Quando a entrega se conclui, a missão fecha o Flow com um resumo: o pull request, a spec reescrita a partir do que você construiu, a mudança de spec arquivada e a issue do Jira, se houver.

## Bom saber

- O Flow só escreve no próprio branch. Fora do Flow, as missões continuam somente leitura.
- Um Flow por missão de cada vez. A pausa sobrevive a uma reinicialização da app.
- Se a cópia do projeto do Flow desaparecer, o Flow fica marcado como **precisa de revisão** (só para informação, nada a decidir) e nada é apagado.
- A faixa nunca troca a execução que você está vendo. Se outra passar a precisar de você nesse meio-tempo, o nome dela no seletor da faixa mostra **precisa de você**.
- O Jira não recebe nada enquanto você está em Flow nem se você o descartar.
- O custo do Flow aparece em Análises como uma superfície própria, **Flow**, e dentro do bloco de missões do agente.
