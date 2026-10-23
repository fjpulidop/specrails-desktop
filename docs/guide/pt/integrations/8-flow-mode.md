# Flow: construir primeiro, spec depois

O Flow é uma forma de construir com um agente quando ainda não sabe exatamente o que quer. Fala com o agente na sua missão, ele escreve e executa código real no seu próprio ramo do Flow (uma cópia à parte do seu projeto) e, quando o resultado está certo, prime **Passar a um rail**: um rail assume as suas alterações, deriva a spec e executa a verificação, a revisão e a entrega habituais.

O Implement serve para delegar trabalho que já sabe descrever. O Flow serve para o descobrir.

## Como começa um Flow

Nunca precisa de pedir o Flow pelo nome. Quando descreve algo exploratório ou visual («quero experimentar…», «não sei como deve ficar»), a missão mostra um cartão com dois caminhos:

- **Flow**: construir em conjunto agora; a spec vem no fim.
- **Spec + Implement**: acordar primeiro uma spec e depois delegá-la a um rail.

Os dois caminhos têm o mesmo peso e aparecem sempre pela mesma ordem: nenhum é recomendado, quem escolhe é você. Em **Porque é que o agente pergunta**, o agente diz numa frase o que o levou a perguntar, e não insiste seja qual for o caminho que escolher ou se premir **Agora não**.

Escolher o Flow abre uma confirmação: o Specrails cria uma cópia à parte do projeto no seu próprio ramo do Flow, onde o agente pode escrever código, e o seu ramo principal não é tocado. Prima **Iniciar Flow**. No board aparece uma spec provisória com a etiqueta **Em Flow** (clique nela para voltar à missão).

Se o seu Specrails Core ainda não consegue executar o Flow, o botão fica desativado e o cartão lista o que falta. Normalmente resolve-se atualizando o Specrails Core.

## Enquanto está em Flow

O modo Flow é indicado onde olha, com a sua própria cor de Flow: o compositor mostra um chip **Flow** ao lado do de autonomia e a dica *Diga ao agente o que mudar neste Flow…*; o título da missão indica **Em Flow**, tal como a sua linha na lista de missões. A conversa marca onde entrou e saiu do Flow, e as respostas do agente escritas em Flow levam uma pequena marca **Flow** junto à hora.

A faixa logo acima do compositor mostra o Flow numa linha curta: o seu estado, **Flow · 7 ficheiros**, **Pausar Flow** e a ação principal, **Passar a um rail**. Quando uma ação não está disponível (o Flow ainda está a guardar, há outra ação em curso), ao passar o rato diz porquê. Abra a linha com a sua seta, como qualquer outra execução, para ver o resto:

- o **ramo** (clique para copiar o nome), as **alterações** com linhas adicionadas e removidas (clique para listar cada ficheiro alterado com o estado e os +/−) e o **custo até agora** tal como faturado pelo fornecedor. Mostra `—` até um turno ter custo reportado, e nunca uma estimativa; um `*` assinala um total que deixa de fora turnos sem preço, com uma nota a dizer quantos;
- **Pré-visualizar** enquanto a app do Flow está a correr (ver abaixo);
- **Descartar**, à parte, apaga as alterações do Flow, o seu ramo e a spec provisória. A confirmação lista o que perde: os ficheiros alterados com os seus +/−, o ramo e a spec.

**Pausar Flow** para o agente e mantém as suas alterações e a spec. A linha mostra então **Retomar Flow**.

Pode escrever enquanto o agente trabalha: no Flow, a sua mensagem **interrompe** o passo atual (o botão de enviar passa a ser um raio) e o agente continua logo com a nova informação. Enquanto o Flow está aberto, a faixa de git sob o compositor sai do caminho: o painel do Flow já mostra o seu ramo.

## Experimentar a app

O agente do Flow corre ele próprio o typecheck e os testes para verificar o trabalho. Quando há algo para experimentar, pergunta com três opções: **Start the app**, **Start and expose on the local network** ou **Not now**. Expô-la permite abrir a app a partir de um telemóvel na mesma Wi-Fi ou VPN, e qualquer pessoa nessa rede pode aceder-lhe.

Quando a app está à escuta, o agente dá-lhe os endereços como ligações e o painel do Flow mostra **Pré-visualizar** com um ponto verde: abre a app no seu navegador. O menu tem o endereço de rede e **Parar app**. A app corre a partir da cópia do Flow, nunca do seu checkout principal, e o Specrails para-a quando pausa, descarta ou entrega o Flow.

## Passar a um rail

Quando estiver satisfeito com o resultado, prima **Passar a um rail**. A linha passa a **Pronto para virar um PR** e abre uma única linha por cima: *Rail 2 vai transformar os seus 7 ficheiros alterados num PR revisto. Se falhar, o seu trabalho fica a salvo.* Prima **Lançar**, ou **Ainda não** para voltar ao Flow; fechar a linha (Esc ou um clique fora) equivale a **Ainda não**. Se o motor da sua conversa não puder fazer a passagem a um rail nesta máquina, uma nota logo abaixo da linha di-lo e é usado o motor padrão do rail.

O rail, o motor, o modelo e o esforço já estão escolhidos (um rail livre e o motor da sua conversa). Para os mudar, abra **Mudar como**; aí vê também o que mudou e o custo até agora. Enquanto a passagem a um rail arranca, a faixa mostra o lançamento sem lacunas e depois acompanha a execução passo a passo. Se for atingido o limite de revisão ou um orçamento, a linha di-lo e nada é lançado. Se a execução não aparecer ao fim de 45 segundos, a faixa deixa de girar e mostra **Ainda a passar a Rail 2…** com **Atualizar**.

O rail deriva a spec e a respetiva alteração da spec a partir do que construiu, verifica-a e revê-a, e o cartão de entrega aparece na missão como em qualquer execução.

Se a execução falhar por um motivo técnico, o trabalho volta sozinho a este Flow, intacto: o cartão diz em palavras simples o que falhou (os códigos ficam em **Detalhes técnicos**) e o agente recebe o erro e explica-o. Se a revisão pedir alterações, o cartão oferece **Voltar ao Flow** ou **Relançar**. Quando a entrega assenta, a missão fecha o Flow com um resumo: o pull request, a spec reescrita a partir do que construiu, a alteração da spec arquivada e o issue do Jira, se existir.

## Bom saber

- O Flow só escreve no seu próprio ramo. Fora do Flow, as missões continuam só de leitura.
- Um Flow por missão de cada vez. A pausa sobrevive a um reinício da app.
- Se a cópia do projeto do Flow desaparecer, o Flow fica marcado como **precisa de revisão** (só para informação, nada a decidir) e nada é apagado.
- A faixa nunca troca a execução que está a ver. Se outra passar a precisar de si entretanto, o nome dela no seletor da faixa diz **precisa de você**.
- O Jira não recebe nada enquanto está em Flow nem se o descartar.
- O custo do Flow aparece em Análise como superfície própria, **Flow**, e dentro do bloco de missões do agente.
