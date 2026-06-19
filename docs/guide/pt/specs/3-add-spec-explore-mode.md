# Adicionar Spec — modo Explore

O modo Explore é uma conversa. Em vez de escrever a spec você mesmo, conversa sobre a ideia com a IA — ela age como parceira de raciocínio, faz perguntas, propõe estrutura e constrói um **rascunho ao vivo** da spec à medida que avança. Quando estiver satisfeito, confirma o rascunho numa spec a sério.

Recorra ao Explore quando a ideia ainda não está totalmente formada, quando há compromissos a discutir, ou quando quer que a IA olhe para o seu código real antes de fixar a spec.

## Criar uma spec no modo Explore

Para dar forma a uma spec no modo Explore:

1. No Dashboard, clique em **Adicionar** e depois escolha **Explore**.
2. Escreva a sua primeira mensagem — a ideia, uma pergunta ou um pensamento ainda por amadurecer.
3. Leia a resposta da IA e continue a responder. A cada turno, ela refina a sua compreensão.
4. Veja o **rascunho ao vivo** atualizar-se ao lado da conversa — esta é a spec a ganhar forma.
5. Quando o rascunho parecer correto, clique em **Criar Spec**.

A conversa fica no seu histórico, por isso pode sempre voltar para ver como a spec foi moldada.

## O rascunho ao vivo

À medida que conversa, um painel de rascunho mostra a spec tal como está neste momento — título, descrição, prioridade, etiquetas, critérios de aceitação. Reescreve-se a cada turno com base no que já discutiram. Não o edita diretamente; orienta-o através da conversa ("na verdade, mete a prioridade em alta", "adiciona um critério sobre o tratamento de erros", e por aí adiante).

É este o coração do modo Explore: nunca está a olhar para um formulário em branco. Está sempre a olhar para uma spec real e em evolução.

## Quanto é que a IA vê: o seletor de contexto

Antes de a IA responder, decide quanto do seu projeto ela pode ver. Um seletor de presets de contexto permite-lhe trocar velocidade por profundidade:

| Preset | O que a IA vê |
|--------|------------------|
| **Mínimo** | Apenas a sua mensagem. O mais rápido e o mais barato. |
| **Leve** | + as suas specs existentes. |
| **Padrão** | + as suas specs e as specs OpenSpec do seu projeto. |
| **Rico** | + acesso de leitura a toda a sua base de código, para poder fundamentar as respostas em código real. |
| **Máx** | Rico, mais uma passagem de enriquecimento Contract Layer na confirmação. |
| **Desktop** | Máx, mais os servidores MCP do seu projeto e os seus próprios servidores MCP aprovados. |

Comece baixo para um brainstorming rápido; suba quando quiser que a IA verifique as suas sugestões contra o seu código real. A escolha é guardada na conversa, por isso não se propaga para outras sessões de Explore.

Se quiser um controlo mais fino, clique em **Ajuste fino** para alternar manualmente as opções subjacentes — incluindo **Os meus MCPs aprovados**, que carrega os servidores MCP que já aprovou localmente sem abrandar a sessão.

## Botões na janela do Explore

- **Criar Spec** — promove o rascunho ao vivo a uma spec a sério com estado **Por fazer**. (Quando está a editar uma spec existente, este botão passa a dizer **Atualizar Spec** e atualiza essa spec no próprio lugar.)
- **Rever →** — abre uma sobreposição de revisão que mostra a spec proposta em comparação com a baseline antes de confirmar, para não haver surpresas.
- **Guardar como rascunho** — persiste a conversa como um ticket de rascunho para que a possa retomar mais tarde. Disponível assim que tiver enviado pelo menos uma mensagem. Veja abaixo.
- **Minimizar** — estaciona a conversa como um chip na doca de chats minimizados, no canto inferior esquerdo. Clique no chip a qualquer momento para voltar diretamente à conversa — nada se perde.
- **Descartar** — deita a conversa fora (pede confirmação primeiro).

## Guardar como rascunho

Ainda não está pronto para confirmar, mas não quer perder o raciocínio? Clique em **Guardar como rascunho**. A conversa torna-se uma **spec de rascunho** no seu quadro, e o rascunho fica ligado à conversa que está por detrás.

Mais tarde, abra o rascunho a partir do quadro e clique em **Continuar a editar** — a conversa original reabre-se com todo o seu histórico de chat intacto, e continua exatamente onde ficou. Os rascunhos nunca são eliminados automaticamente; ficam à sua espera.

Isto torna o Explore seguro para ideias ainda por amadurecer: comece uma conversa, chegue a algum lado, guarde-a como rascunho e volte amanhã.

Para tudo sobre rascunhos — incluindo o enriquecimento Contract Layer — veja [Rascunhos e o Contract Layer](drafts-and-contract-layer.md).

## Nota sobre múltiplos fornecedores

Se o seu projeto tiver mais do que um fornecedor de IA instalado, um seletor de motor permite-lhe escolher qual deles conduz a conversa do Explore. Projetos com um único fornecedor não o mostram.

## Para onde ir a seguir

- [Rascunhos e o Contract Layer](drafts-and-contract-layer.md) — guardar trabalho em curso e enriquecer specs para o pipeline.
- [Adicionar Spec — modo Quick](add-spec-quick-mode.md) — quando a ideia já está clara.
- [Executar pipelines](running-pipelines.md) — implemente a sua spec assim que estiver pronta.
