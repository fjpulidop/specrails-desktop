<!-- guide-revision: mission-first-v1 -->

# Revise uma entrega no app {#review-a-delivery}

Uma entrega pronta para revisão tem duas visões: **Resumo** (o veredito, as evidências e os botões de decisão) e **Alterações** (o que a entrega realmente mudou). Abra a revisão pelo botão **Revisar** da entrega e escolha **Alterações**.

## Leia as alterações

A lista de arquivos à esquerda mostra cada arquivo alterado com seu estado (adicionado, modificado, excluído, renomeado), suas contagens de linhas `+` e `−` e uma marca quando você o dá como visto. O diff à direita carrega um arquivo por vez, então uma alteração grande continua fluida. Alterne entre os layouts **Unificado** e **Dividido**; o Specrails lembra da sua escolha. Um arquivo muito grande mostra suas primeiras linhas com **Carregar o diff completo do arquivo**; um arquivo binário é listado como binário.

As alterações são medidas a partir do ponto em que a entrega se separou da branch base, então o que chegou à base depois não aparece. Se a entrega ainda não tem uma branch combinada, você pode escolher a branch de qual spec ler.

## Notas do revisor sobre o código

Os achados do revisor, os riscos apontados e os comentários de revisão que a execução devia resolver aparecem sob a linha a que se referem. Notas que não indicam arquivo nem linha ficam listadas acima da lista de arquivos, então nada fica escondido. Entregas antigas, e revisores que não indicaram um lugar, mostram seus achados nessa lista.

## Peça ao agente para mudar algo

Selecione linhas clicando nos números (Shift-clique amplia o intervalo), escolha **Pedir ao agente para mudar isto** e descreva a mudança. O Specrails salva como feedback de revisão na spec, com o arquivo, o intervalo de linhas e o código selecionado, e mostra uma mensagem com um link para a spec. A próxima execução dessa spec o receberá. Para iniciá-la agora, use **Pedir alterações** no Resumo. Aqui não há threads de comentários entre pessoas; converse com sua equipe no GitHub.

## Abra no seu editor

**Abrir no editor** abre o arquivo, na linha selecionada, no VS Code, no Cursor ou em uma IDE da JetBrains. Escolha o editor em **Configurações → Código → Editor**. O arquivo abre a partir da sua própria cópia do projeto, onde a branch da revisão pode não estar ativa.

## Teclado

| Tecla | Ação |
| --- | --- |
| `j` / `k` | Arquivo alterado seguinte / anterior |
| `n` / `p` | Nota do revisor seguinte / anterior |
| `v` | Marcar o arquivo como visto |

As teclas são ignoradas enquanto você digita em um campo. Marcar como visto é privado: se o arquivo mudar numa revisão posterior, ele mostra **Alterado desde que você viu** e volta a contar como não visto.
