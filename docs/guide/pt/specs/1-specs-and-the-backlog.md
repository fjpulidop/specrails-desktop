# Specs e o backlog

Uma **spec** é a unidade de trabalho que o pipeline de IA implementa. Pense nela como um ticket: um título, uma descrição do que quer fazer, uma prioridade e, opcionalmente, etiquetas. Quando lança o pipeline, os agentes de IA leem a spec e agem sobre ela — por isso, uma spec clara é o input mais importante para um bom resultado.

Por vezes, na app, as specs também são chamadas de **tickets** — as duas palavras significam o mesmo.

## O quadro

Cada projeto abre no seu **Dashboard**, que mostra a **SpecsBoard** — a lista de todas as specs do projeto. Este é o seu backlog. É aqui que cria novas specs, define a sua prioridade, as arrasta para um rail para as implementar e vê o seu estado mudar à medida que o trabalho avança.

O quadro tem dois modos de visualização, alternados a partir de um botão na barra de ferramentas e memorizados por projeto:

- **Vista de post-its** (a predefinida) — mosaicos em forma de cartão com resumos curtos.
- **Vista de lista** — linhas compactas de uma só linha.

O **seletor de estados** da barra de ferramentas mostra cada estado como um chip próprio com contagem em direto — mais dois grupos inteligentes: **Ativas** (a predefinição — tudo o que ainda está em movimento: rascunhos, por fazer, em curso e em revisão) e **Todos** (tudo, com Concluído fixado no fundo). A sua escolha é lembrada por projeto e espelhada no URL, pelo que um refresh ou um link partilhado restaura a vista exata. Em projetos ligados ao Jira aparece ainda um menu de **estado Jira**, que lista os estados *reais* do fluxo de trabalho do quadro (os nomes tal e qual, p. ex. "Code Review", cada um com contagem em direto) agrupados sob o estado a que mapeiam — combina-se com os chips de estado. Também pode filtrar por **etiqueta**, e ordenar por **Predefinida**, **Ticket #** ou **Prioridade** (cada uma com um seletor ascendente/descendente).

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

Para criar uma spec, clique em **Adicionar** (o botão Mais na barra de ferramentas da SpecsBoard). Abre-se a janela **Adicionar Spec** com algumas formas de trabalhar:

- **Quick** — descreve o que quer e a IA escreve a spec completa de uma só vez. Veja [Adicionar Spec — modo Quick](add-spec-quick-mode.md).
- **Explore** — conversa com a IA, e ela ajuda-o a dar forma à spec turno a turno. Veja [Adicionar Spec — modo Explore](add-spec-explore-mode.md).
- **Raw** — o que quer que escreva é guardado tal e qual como uma spec, sem qualquer IA envolvida. Use este modo quando já tem o texto da spec pronto.

Qual escolher depende do quão clara já está a ideia. Sabe exatamente o que quer? Quick. Ainda a pensar nela? Explore. Já tem o texto? Raw.

## Para onde ir a seguir

- [Adicionar Spec — modo Quick](add-spec-quick-mode.md) — a forma mais rápida de transformar uma ideia numa spec.
- [Adicionar Spec — modo Explore](add-spec-explore-mode.md) — dê forma a uma spec em conversa.
- [Rascunhos e o Contract Layer](drafts-and-contract-layer.md) — guarde trabalho em curso e enriqueça specs para o pipeline.
