# Personalizar modelos por agente

A coisa mais útil que os perfis lhe permitem fazer é **escolher o modelo certo para cada passo**. Um passo de planeamento pode merecer o seu modelo mais forte; um passo de construção rotineiro pode ficar perfeitamente satisfeito com algo mais rápido e mais barato. Os perfis deixam-no exprimir exatamente isso.

É aqui que a separação entre o partilhado e o por projeto compensa:

- As *definições* dos agentes mantêm-se partilhadas por toda a equipa.
- O *modelo com que cada agente corre* é configurado **por projeto**, dentro de um perfil, e só afeta o seu projeto.

Mude um modelo e muda o custo e o comportamento para esse projeto — sem tocar na configuração de mais ninguém nem nas instruções subjacentes do agente.

## Mudar o modelo que um agente usa

Em **Agentes → Perfis**, selecione um perfil e abra o seu editor de cadeia de agentes. Cada agente na cadeia tem um campo de modelo. Há também um modelo de **orquestrador** que corre a coordenação de topo do pipeline.

Os valores de modelo são aliases — para o Claude são `opus`, `sonnet` e `haiku` (do mais capaz → ao mais rápido). Defina o alias que quiser por agente:

- Deixe o modelo de um agente **em branco** para recorrer à predefinição do próprio ficheiro do agente.
- Defina-o explicitamente para o substituir apenas neste perfil.

Guarde, e o próximo rail lançado com esse perfil usa os novos modelos. Os jobs já em execução mantêm o seu snapshot.

## Criar perfis como `fast` e `max`

O padrão natural é um par de perfis com nome a que recorre consoante o trabalho:

**Um perfil `fast`** — para alterações pequenas e de baixo risco em que quer velocidade e uma fatura menor:

- Architect: um modelo intermédio ou rápido — o plano é simples.
- Developer: um modelo rápido — a alteração é mecânica.
- Reviewer: mantenha-o sólido, mas também pode poupar aqui.

**Um perfil `max`** — para funcionalidades complicadas e de alto risco em que quer que cada passo seja o mais afiado possível:

- Architect, developer e reviewer: o seu modelo mais forte em toda a linha.

### Duas formas de construir um

1. **Duplicar e ajustar** *(recomendado).* Selecione o seu perfil `default`, **Duplique-o**, dê à cópia um nome em kebab-case como `fast` ou `max`, e depois ajuste o modelo de cada agente. Herda uma cadeia e um encaminhamento que sabe estarem bons e muda apenas o que pretende.
2. **Começar do zero.** Crie um **Perfil em branco** e monte a cadeia você mesmo. Tem ainda assim de incluir o trio de base (`sr-architect`, `sr-developer`, `sr-reviewer`) — o pipeline depende dos três — e exatamente uma regra de encaminhamento terminal do tipo apanha-tudo, que tem de ser a última.

Os nomes de perfil são em kebab-case minúsculo (p. ex. `fast`, `max`, `cheap-and-cheerful`).

## Encaminhar tarefas para agentes específicos

As **regras de encaminhamento** de um perfil decidem que agente trata uma tarefa etiquetada. Cada regra lista tags de tarefa e um agente de destino; vence a primeira regra cujas tags coincidam, e uma única regra `default: true` no fim apanha tudo o resto. Apenas agentes que estejam realmente na cadeia do perfil podem ser destinos de encaminhamento — o editor faz cumprir esta regra.

Para uso do dia a dia não vai mexer no encaminhamento: a regra apanha-tudo envia o trabalho para o developer e isso está correto. Recorra a regras de tags quando quiser, por exemplo, que o trabalho etiquetado com `migration` vá para um especialista.

## Escolher o perfil quando lança

Tudo isto se junta no lançamento: no cabeçalho do rail, escolha `fast`, `max` ou `default` por rail. Um batch pode misturá-los — uma correção minúscula em `fast`, uma grande funcionalidade em `max`, ambas a correr ao mesmo tempo. Veja [Perfis e a predefinição equilibrada](profiles-and-the-balanced-default) para o fluxo de seleção.

## Uma nota sobre segurança

Eliminar um perfil é seguro para o trabalho em curso: os jobs já lançados com ele mantêm o seu snapshot, e os lançamentos futuros simplesmente recorrem à ordem de resolução. Experimente à vontade.

## Para onde ir a seguir

- [Agentes personalizados e o catálogo](custom-agents-catalog) — adicione agentes para pôr nas suas cadeias.
