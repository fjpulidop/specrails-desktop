<!-- guide-revision: mission-first-v1 -->

# Revise uma entrega no app {#review-a-delivery}

Uma entrega pronta para revisão tem duas visões: **Resumo** (o veredito, as evidências e os botões de decisão) e **Alterações** (o que a entrega realmente mudou). Abra a revisão pelo botão **Revisar** da entrega e escolha **Alterações**.

## Leia as alterações

A lista de arquivos à esquerda mostra cada arquivo alterado com seu estado (adicionado, modificado, excluído, renomeado), suas contagens de linhas `+` e `−` e uma marca quando você o dá como visto. O diff à direita carrega um arquivo por vez, então uma alteração grande continua fluida. Alterne entre os layouts **Unificado** e **Dividido**; o Specrails lembra da sua escolha. Um arquivo muito grande mostra suas primeiras linhas com **Carregar o diff completo do arquivo**; um arquivo binário é listado como binário.

As alterações são medidas a partir do ponto em que a entrega se separou da branch base, então o que chegou à base depois não aparece. Se a entrega ainda não tem uma branch combinada, você pode escolher a branch de qual spec ler.

## Notas do revisor sobre o código

Os achados do revisor, os riscos apontados e os comentários de revisão que a execução devia resolver aparecem sob a linha a que se referem. Notas que não indicam arquivo nem linha ficam listadas acima da lista de arquivos, então nada fica escondido. Entregas antigas, e revisores que não indicaram um lugar, mostram seus achados nessa lista.

## Peça ao agente para mudar algo

Selecione linhas clicando nos números (Shift-clique amplia o intervalo), escolha **Pedir uma mudança ao agente** e descreva a mudança. O Specrails salva como feedback de revisão na spec, com o arquivo, o intervalo de linhas e o código selecionado, e mostra uma mensagem com um link para a spec. A próxima execução dessa spec o receberá. Para iniciá-la agora, use **Pedir alterações** no Resumo. Aqui não há threads de comentários entre pessoas; converse com sua equipe no GitHub.

## Abra no seu editor

**Abrir no editor** abre o arquivo, na linha selecionada, no VS Code, no Cursor ou em uma IDE da JetBrains. Escolha o editor em **Configurações → Código → Editor**. O arquivo abre a partir da sua própria cópia do projeto, onde a branch da revisão pode não estar ativa.

## Veja os conflitos antes do merge {#merge-preview}

Cada entrega que espera por você é comparada com sua branch base **como está agora** (o último `origin/<base>` buscado), sem tocar no seu checkout: o Git combina as duas em memória e nada é gravado no seu repositório. O card do rail, o pacote de revisão e o live board então mostram:

- **Conflita com main em …**: a mudança não entra mais sem conflitos; os arquivos são listados. Aparece com o visual de aviso.
- **Colide com o Rail N em …**: outra entrega esperando sobre a mesma base muda as mesmas linhas, então a que for integrada em segundo lugar terá conflitos.
- **main avançou N commits desde que esta branch foi criada**: a base avançou; considere atualizar a branch antes de decidir.
- **Já está em main**: a mudança já entrou (por exemplo depois de um squash merge).

A prévia se atualiza quando uma entrega muda de estado ou um run termina. Quando o Specrails integra vários resultados por conta própria, integra primeiro os que entram sem conflitos. É preciso Git 2.38 ou posterior; com um Git mais antigo a prévia diz que não está disponível.

## Escolha o que acontece com uma entrega {#pr-decision}

Uma execução concluída pede uma só coisa: o que fazer com o resultado. O cartão mostra um botão principal para o próximo passo (criar o PR, publicá-lo ou verificá-lo) e, ao lado, **Revisar**, que abre o pacote de revisão em linguagem simples. Todo o resto fica em **Mais ações**:

- **Mudar para o branch** coloca o branch na pasta do seu projeto para você testá-lo.
- **Integrar localmente** mescla o resultado no seu branch base neste computador. Não precisa de GitHub e você confirma antes.
- **Descartar** remove o resultado e o seu branch. Você confirma antes.

Se uma ação falhar, o aviso diz o que não deu certo e oferece **Repetir**.

## Deixe o Specrails manter o PR verde {#pr-ci}

Depois de criar um PR a partir de uma missão, a conversa oferece **Acompanhar e corrigir o CI do PR #N**. É opcional e nunca começa sozinho. Escolha **Iniciar** e o Specrails espera pelos checks do PR, corrige os que falham, resolve os conflitos com o branch base fazendo merge dele, verifica o resultado no seu computador e envia a correção para o mesmo PR, até os checks ficarem verdes. Você pode acompanhar na faixa de execuções ("Esperando pelo CI", "Corrigindo os checks que falham", "Enviando a correção para o PR").

Ele nunca faz push forçado, nunca reescreve o branch, nunca enfraquece um check e nunca publica, faz merge ou fecha o PR: essas decisões continuam sendo suas. Se não conseguir terminar (os checks continuam falhando, um check obrigatório nunca informa resultado, precisa de um segredo que só você pode fornecer), ele para e diz por quê. **Agora não** oculta a oferta para esta entrega. Você pode iniciá-lo depois com **Corrigir CI / Conflitos** em **Mais ações** no cartão do PR ou no rail.

## Teclado

| Tecla | Ação |
| --- | --- |
| `j` / `k` | Arquivo alterado seguinte / anterior |
| `n` / `p` | Nota do revisor seguinte / anterior |
| `v` | Marcar o arquivo como visto |

As teclas são ignoradas enquanto você digita em um campo. Marcar como visto é privado: se o arquivo mudar numa revisão posterior, ele mostra **Alterado desde que você viu** e volta a contar como não visto.
