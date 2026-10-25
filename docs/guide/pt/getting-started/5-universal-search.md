# Busca universal (⌘K)

Pressione **⌘K** (**Ctrl+K** no Windows e no Linux) para buscar quase tudo no Specrails em um só lugar: missões, specs, logs de jobs, arquivos, configurações e este guia. Digite uma consulta comum para buscar missões, projetos, specs e jobs recentes como sempre, ou comece com um **prefixo** para buscar em uma única fonte.

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

`/` conhece os principais blocos de configurações, no seu idioma: tema, idioma, editor, orçamentos, notificações, webhooks, atualizações, branch, ambiente, telemetria, regras e mais. As configurações do projeto aparecem quando há um projeto aberto. Escolha uma e a janela certa abre nesse bloco. Sem prefixo, uma correspondência forte (três ou mais caracteres) acrescenta até três configurações aos resultados normais.

## Logs de jobs

`log:` busca em um índice compacto, não na saída bruta de uma execução: o comando, o nome do loop, os títulos das fases e o diagnóstico curto de uma execução que falhou, foi bloqueada ou travou. Nunca guarda fluxos de tokens nem a saída de ferramentas, então continua pequeno e rápido. É mantido por projeto e guarda as execuções mais recentes.

## Bom saber

- `#`, `f:` e `log:` buscam no projeto ativo; abra um projeto primeiro.
- O escopo de arquivos respeita as regras de exclusão do explorador de código.
- Cada grupo mostra só os melhores resultados; refine a consulta para restringir.
