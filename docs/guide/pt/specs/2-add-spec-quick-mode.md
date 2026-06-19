# Adicionar Spec — modo Quick

O modo Quick é para quando já sabe o que quer. Escreve a sua ideia, a IA redige a spec completa, e ela aterra no seu quadro como **Por fazer**. Sem idas e vindas — basta descrever e avançar.

## Criar uma spec no modo Quick

Para criar uma spec rapidamente:

1. No Dashboard, clique em **Adicionar** (o botão Mais na barra de ferramentas da SpecsBoard).
2. Escolha o modo **Quick**.
3. Escreva a sua ideia no campo de texto — uma frase ou um parágrafo, o que melhor a capturar.
4. Clique para gerar.

Enquanto a spec está a ser escrita, uma pequena notificação no canto mostra o nome do projeto, um excerto da sua ideia e o **tempo decorrido** ("A gerar… 0:12"). Quando termina, a notificação muda para "Gerada em <tempo>" com uma ação **Ver** que o leva diretamente à sua nova spec.

É este o fluxo completo. Tudo o que se segue é um ajuste fino opcional.

## O que pode ajustar

**Modelo** — por predefinição, a IA escolhe um modelo sensato. Pode substituí-lo por spec a partir do seletor de modelo se quiser um mais rápido ou mais capaz.

**Motor** — se o seu projeto tiver mais do que um fornecedor de IA instalado (qualquer combinação de Claude, Codex e Gemini), um seletor de motor fica no topo da janela para que possa escolher qual deles gera esta spec. A sua escolha é memorizada por projeto. Projetos com um único fornecedor não mostram isto — não há nada por onde escolher.

**Contexto** — o modo Quick normalmente corre como um único turno, porque não precisa de ler a sua base de código para escrever uma spec a partir da sua descrição. Mas um seletor de contexto permite dar-lhe mais material para trabalhar:

- No nível mais baixo, lê apenas a sua descrição.
- Em níveis mais altos, pode ler as suas specs existentes, as specs OpenSpec do seu projeto, e até toda a sua base de código antes de escrever.

Quanto mais contexto lhe der, mais demora a geração (passa a multi-turno para poder ler primeiro), mas a spec volta fundamentada no seu projeto real. Recorra a níveis de contexto mais altos quando a spec precisar de referenciar código real, nomes de ficheiros ou comportamentos existentes.

**Anexos** — largue mockups, briefs ou ficheiros de dados no campo da ideia. A IA lê-os como parte da escrita da spec. (Os anexos também passam a geração para multi-turno.)

**Enriquecer com Contract Layer** — um interruptor que acrescenta um bloco estruturado à spec gerada, para que o pipeline a jusante não tenha de adivinhar nomes nem formatos de dados. É opcional e está desativado por predefinição; a sua última escolha é memorizada por projeto. Veja [Rascunhos e o Contract Layer](drafts-and-contract-layer.md) para saber o que adiciona e quando vale a pena.

## Quando usar o modo Quick vs Explore

Use o **Quick** quando a ideia já está clara na sua cabeça — podia escrever a spec você mesmo, mas prefere que a IA o faça. Use o [**Explore**](add-spec-explore-mode.md) quando ainda está a pensar no assunto e quer um parceiro que o ajude a dar-lhe forma.

Uma spec criada no modo Quick é uma spec perfeitamente normal: pode mais tarde abri-la e **Continuar a editar** numa sessão de Explore, se precisar de refinamento.

## Para onde ir a seguir

- [Adicionar Spec — modo Explore](add-spec-explore-mode.md) — para specs que precisam de forma.
- [Rascunhos e o Contract Layer](drafts-and-contract-layer.md) — o enriquecimento Contract Layer explicado.
- [Executar pipelines](running-pipelines.md) — arraste a sua nova spec para um rail e implemente-a.
