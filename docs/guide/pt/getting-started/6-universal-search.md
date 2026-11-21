# Busca universal (⌘K)

Pressione **⌘K** (**Ctrl+K** no Windows e no Linux) para buscar quase tudo no Specrails em um só lugar: missões, specs, logs de jobs, arquivos, configurações e este guia. Digite uma consulta comum para buscar missões, projetos, specs e jobs recentes como sempre, ou comece com um **prefixo** para buscar em uma única fonte.

## Retomar

Com a caixa vazia, o primeiro grupo é **Retomar**: suas missões e jobs com atividade mais recente, do mais novo ao mais antigo, com o mais recente do projeto aberto na frente para que **Enter** deixe você onde está. Cada linha mostra a luz do seu estado e o nome do projeto quando não é o que está aberto. Quando algo precisa de você, uma linha no topo diz quantas coisas (**3 pendências**) e abre a caixa de entrada, a única lista do que espera por você; os itens da caixa em si não são listados aqui.

Pressione de **⌘1** a **⌘6** (de **Ctrl+1** a **Ctrl+6** no Windows e no Linux) para abrir diretamente uma linha de missão ou de job (a linha da caixa não tem número), ou escolha uma linha com as setas e **Enter**. Uma linha abre exatamente como em outros lugares: uma missão abre a missão e um job abre o job. Enquanto a paleta está aberta essas teclas são dela: os atalhos de página (⌘1–5) e a troca de projeto (⌥⌘1–9) esperam até ela fechar. A ordem fica fixa enquanto a paleta estiver aberta, para que nenhuma linha mude de lugar sob seus dedos; os estados continuam sendo atualizados, e a lista é reordenada na próxima vez que você abrir. As linhas deste grupo não se repetem em Missões nem em Jobs.

## Prefixos

| Digite | Busca | Enter abre |
| --- | --- | --- |
| `#` | Specs: título, resumo, descrição, etiquetas, notas de fora do escopo, adendos e comentários. `#12` encontra a spec 12. | A spec |
| `@` | Missões: título e conteúdo da conversa. | A missão |
| `/` | Configurações (do Desktop e do projeto) pelo nome ou pelo jeito que você as chamaria. | A janela de configurações nesse bloco, visível e com foco |
| `f:` | Arquivos do projeto, por nome ou caminho. | O arquivo no explorador de código |
| `log:` | Logs de jobs: comandos, nomes de loops, títulos de fases e diagnósticos de falha. | O job |
| `?` | Este guia: títulos de páginas e cabeçalhos. | O guia nesse cabeçalho |

Ao digitar um prefixo, ele vira uma **etiqueta** na caixa de busca e a caixa guarda só a sua consulta. Pressione **Backspace** com a caixa vazia (ou clique no × da etiqueta) para remover o escopo. Com a caixa vazia, a paleta lista os prefixos sob a caixa; clique em um para começar. `>` continua listando ações, como antes.

## Destaques

Os resultados mostram um trecho curto em torno da primeira ocorrência, com o texto correspondente destacado. A busca ignora maiúsculas e acentos, então `revisao` encontra «Revisão».

## Configurações

`/` conhece os principais blocos de configurações, no seu idioma: tema, idioma, editor, orçamentos, notificações, webhooks, atualizações, branch, ambiente, telemetria, regras e mais. As configurações do projeto aparecem quando há um projeto aberto. Escolha uma e a janela certa abre nesse bloco. Sem prefixo, uma correspondência forte (três ou mais caracteres) acrescenta até três configurações aos resultados normais. `/budget` também encontra o painel de Orçamento (limites, projeção, e se…), onde ficam os limites semanal e mensal. Um comando com barra, como `/implement`, aparece sob as configurações, em um grupo próprio, então o prefixo `/` nunca o esconde.

## Logs de jobs

`log:` busca em um índice compacto, não na saída bruta de uma execução: o comando, o nome do loop, os títulos das fases e o diagnóstico curto de uma execução que falhou, foi bloqueada ou travou. Nunca guarda fluxos de tokens nem a saída de ferramentas, então continua pequeno e rápido. É mantido por projeto e guarda as execuções mais recentes.

## Bom saber

- `#`, `f:` e `log:` buscam no projeto ativo; abra um projeto primeiro.
- O escopo de arquivos respeita as regras de exclusão do explorador de código.
- Cada grupo mostra só os melhores resultados; refine a consulta para restringir.
