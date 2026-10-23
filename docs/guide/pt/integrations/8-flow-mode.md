# Flow: construir primeiro, spec depois

O Flow é uma forma de construir com um agente quando ainda não sabe exatamente o que quer. Fala com o agente na sua missão, ele escreve e executa código real num worktree isolado e, quando o resultado é o certo, diz **É isto**: um rail assume o worktree, deriva a spec e executa a verificação, a revisão e a entrega habituais.

O Implement serve para delegar trabalho que já sabe descrever. O Flow serve para o descobrir.

## Como começa um Flow

Não precisa de pedir o Flow pelo nome. Quando descreve algo exploratório ou visual («quero experimentar…», «não sei como deve ficar»), a missão mostra um cartão com dois caminhos:

- **Flow** — construir em conjunto agora; a spec chega no fim.
- **Spec + Implement** — acordar primeiro uma spec e depois delegá-la a um rail.

Os dois caminhos têm o mesmo peso e aparecem sempre pela mesma ordem: nenhum é recomendado, quem escolhe é você. Em **Porque é que o agente pergunta**, o agente explica numa frase o que o levou a perguntar, e não insiste, seja qual for o caminho escolhido ou se carregar em **Agora não**.

Ao escolher Flow abre-se uma confirmação: o Specrails cria um worktree isolado onde o agente pode escrever código, e o seu ramo principal não é tocado. Carregue em **Iniciar Flow**. No board aparece uma spec provisória com a etiqueta **Em Flow** (clique nela para voltar à missão).

Se o seu Specrails Core ainda não consegue executar o Flow, o botão fica desativado e o cartão indica o que falta; normalmente resolve-se atualizando o Specrails Core.

## Durante o Flow

A conversa muda de aspeto (uma linha fina de destaque na margem) e aparece uma barra acima do compositor:

- o **ramo** do worktree, os **ficheiros alterados** com linhas adicionadas e removidas, e o **custo real** do Flow até agora, conforme faturado pelo fornecedor. Mostra `—` até um turno ter custo comunicado, e nunca uma estimativa;
- **Ver alterações** lista cada ficheiro alterado com o estado e +/−;
- **Pausar** para o agente e mantém o worktree e a spec. A missão mostra então **Retomar Flow**;
- **Descartar** apaga, após confirmação, o worktree, o seu ramo e a spec provisória;
- **É isto** — a ação principal, abaixo.

Pode escrever enquanto o agente trabalha: no Flow a sua mensagem **interrompe** o passo atual (o botão de enviar passa a ser um raio) e o agente continua de imediato com a nova informação. A faixa de git por baixo do compositor mostra o ramo do worktree.

## Experimentar a app

O agente do Flow executa ele próprio o typecheck e os testes para verificar o trabalho. Quando há algo para experimentar, pergunta com três opções: **Start the app**, **Start and expose on the local network** ou **Not now**. Expô-la permite abrir a app num telemóvel na mesma Wi-Fi ou VPN, e qualquer pessoa nessa rede a pode alcançar.

Quando a app está à escuta, o agente dá-lhe os endereços como links e a barra do Flow mostra **Pré-visualizar** com um ponto verde: abre a app no navegador. O menu tem o endereço de rede e **Parar app**. A app corre no worktree do Flow, nunca no checkout principal, e o Specrails para-a quando pausa, descarta ou entrega o Flow.

## É isto

Quando estiver satisfeito com o resultado, carregue em **É isto**. A barra do Flow e o tratamento visual desaparecem e surge o cartão de lançamento de rail de sempre, com o loop **Flow → Spec** pré-selecionado e um rail livre já escolhido. Ajuste o motor, o modelo ou o esforço se quiser e carregue em **Lançar**. Se o limite de revisão ou um orçamento tiver sido atingido, o cartão indica-o e não lança. **Ainda não** volta ao Flow.

O rail deriva a spec do Specrails e a alteração OpenSpec a partir do que construiu, verifica-as e revê-as, e o cartão de entrega aparece na missão como em qualquer execução.

## Convém saber

- O Flow só escreve dentro do seu worktree. Fora do Flow as missões continuam só de leitura.
- Um Flow por missão de cada vez. A pausa sobrevive a um reinício da app.
- Se o worktree desaparecer, o Flow fica marcado como **precisa de revisão** e nada é apagado.
- O Jira não recebe nada enquanto está em Flow nem se o descartar.
- O custo do Flow aparece na Análise como superfície própria, **Flow**, e no bloco das missões do agente.
