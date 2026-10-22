# Trabalhar em um projeto existente

Estes recursos ajudam as execuções a respeitar um projeto que já existe: o que uma spec deixa de fora, as perguntas do arquiteto antes de planejar, quais requisitos um teste realmente comprova, como descrever o código antigo antes de mudá-lo e as regras que sua equipe já escreveu. Cada um precisa de uma versão do specrails-core que o suporte; até lá, o interruptor fica desativado com um aviso para atualizar o Core.

## Fora do escopo

Cada spec pode listar o que deliberadamente **não** muda. Quick e Explore preenchem isso para você; na janela da spec aparece como **Fora do escopo** abaixo da descrição, um item por linha, e pode ser editado como qualquer outro campo. Os agentes recebem isso com a spec a cada lançamento.

## Perguntas do arquiteto no Jira

Em **Configurações ▸ Ancoragem em projetos existentes**, ative **Publicar esclarecimentos do arquiteto no Jira**. Quando uma execução para porque o arquiteto precisa de uma resposta, ou segue com suposições, o Specrails as publica como um comentário na issue do Jira vinculada. Responda a esse comentário no Jira: a resposta é adicionada à spec como esclarecimento e a próxima execução da spec a lê. Você ainda pode responder a uma execução pausada pelo app.

## Requisitos demonstrados

Quando um teste nomeia o requisito que comprova (`[spec:<capacidade>/<requisito>]` no título), a página de revisão mostra **Requisitos demonstrados X/Y**: quais requisitos um teste aprovado comprova, quais ainda não têm teste e quais a própria mudança tocou. A análise mostra o mesmo por loop. Para a CI falhar quando um requisito alterado não tem teste, adicione `specrails-core pipeline trace --check --tests-passed` depois dos seus testes.

A biblioteca de loops também oferece **Varredura de drift**, um loop somente leitura que compara o que cada spec diz com o que o código faz e lista cada contradição. Não altera nada.

## Baseline ao tocar

Ative **Baseline ao tocar** para que uma mudança que alcança código que nenhuma spec descreve comece descrevendo-o: testes de como o código se comporta hoje, comprovados no código inalterado, e uma spec curta do que existe. A página de revisão mostra **Spec criada por onde o trabalho passou** com o módulo, os requisitos e os testes, e o custo aparece à parte. Se esses testes falharem no código inalterado, a execução para antes de editar o módulo e informa isso.

## Regras do projeto

**Configurações ▸ Regras do projeto** lista as verificações que seu projeto já executa (lint, tipos, testes, CI) e cada regra escrita em arquivos como `CLAUDE.md` ou `AGENTS.md`, classificadas em:

- **Aplicada**: uma verificação já a garante.
- **Automatizável**: uma verificação poderia. **Criar spec** a transforma em spec com um clique.
- **Somente humana**: alguém precisa olhar. Elas aparecem em cada página de revisão em **Precisa de olhos humanos**.

As regras que o Core ainda não conseguiu classificar (por exemplo, logo após adicionar o projeto, quando o inventário roda offline) aparecem como **Não classificada**; **Refazer inventário** com um provedor configurado as classifica.

**Refazer inventário** atualiza a lista. Quando um projeto ainda não tem comandos de verificação, as configurações do agent runtime oferecem essas verificações primeiro.
