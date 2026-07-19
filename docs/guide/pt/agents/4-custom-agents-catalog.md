# Agentes personalizados e o catálogo

Os perfis decidem *que agentes correm e com que modelos*. Mas de onde vêm os próprios agentes? Vêm do **catálogo de Agentes**.

Abra **Agentes → Catálogo** em qualquer projeto. É um visualizador apenas de leitura de todos os agentes disponíveis para esse projeto, em dois grupos:

- **Agentes upstream** — os agentes que vêm com o `specrails-core`: o trio de base (`sr-architect`, `sr-developer`, `sr-reviewer`) e quaisquer especialistas como o `sr-merge-resolver`.
- **Agentes personalizados** — agentes que adicionou você mesmo, com o nome `custom-*`.

Cada entrada do catálogo mostra para que serve o agente e o seu modelo predefinido, para que possa ver toda a equipa antes de ligar os agentes a uma cadeia de perfil.

## Adicionar um agente personalizado

Roles são assets nativos do provider: Claude usa
`.claude/agents/custom-<nome>.md`; Kimi usa
`.kimi-code/skills/custom-<nome>/SKILL.md`.

Quando o asset existe, aparece no catálogo desse provider e o seu id pode ser adicionado a um perfil do mesmo provider. `custom-docs` corresponde a `.claude/agents/custom-docs.md` em Claude ou `.kimi-code/skills/custom-docs/SKILL.md` em Kimi; ambos ficam separados.

Como vivem no seu repositório, os agentes personalizados são **ativos de equipa que se podem committar**: faça commit do ficheiro e toda a equipa fica com o agente. Isto espelha a ideia central de toda a secção Agentes —

> **As definições dos agentes são partilhadas (vivem no repositório e viajam com o `git`). A configuração dos modelos é por projeto (vive nos perfis).**

Core protege ambos os formatos. Kimi permite criação/edição manual e execução;
Generate, Test e AI Refine são recusados antes do spawn.

## Pôr um agente personalizado a trabalhar

O fluxo típico:

1. Crie o asset Claude ou Skill Kimi nativo com instruções/modelo válidos.
2. Confirme que aparece em **Agentes → Catálogo** em Personalizados.
3. Em **Agentes → Perfis**, adicione o agente à cadeia de um perfil (substituindo opcionalmente o seu modelo para esse perfil).
4. Adicione uma regra de encaminhamento para que as tarefas com as tags certas cheguem até ele — ou confie na ordem da cadeia.
5. Lance um rail com esse perfil a partir do cabeçalho do rail.

## Acompanhar o desempenho dos perfis

A secção Agentes tem também um separador **Utilização** — uma análise por perfil de quantos jobs correram sob cada perfil numa janela selecionada. É uma forma rápida de confirmar que a sua divisão `fast`/`max` está mesmo a ser usada como pretendia, e de detetar para que perfil a sua equipa tende a gravitar.

## Resumo de toda a secção

- Os **Agentes** são os membros especializados da equipa — o trio partilhado mais especialistas e os seus agentes personalizados. ([Conheça os agentes](meet-the-agents))
- Os **Perfis** empacotam que agentes correm, com que modelos e como as tarefas são encaminhadas — selecionados por rail no lançamento. O perfil default é a escolha equilibrada do dia a dia. ([Perfis e a predefinição equilibrada](profiles-and-the-balanced-default))
- Os **Modelos** são afinados por agente, por projeto, dentro dos perfis — construa `fast` e `max` à medida do trabalho. ([Personalizar modelos por agente](customizing-models-per-agent))
- O **catálogo** mostra todos os agentes, e o namespace `custom-*` permite-lhe fazer crescer a equipa — definições partilhadas, configuração por projeto.
