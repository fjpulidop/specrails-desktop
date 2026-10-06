# Agentes personalizados e o catálogo

Os perfis decidem *que agentes correm e com que modelos*. Mas de onde vêm os próprios agentes? Vêm do **catálogo de Agentes**.

Abra **Agentes → Catálogo** em qualquer projeto. É um visualizador apenas de leitura de todos os agentes disponíveis para esse projeto, em dois grupos:

- **Agentes upstream** — os papéis que o motor Core define em tempo de execução: o trio de base (`sr-architect`, `sr-developer`, `sr-reviewer`). Não são ficheiros do seu repositório; o catálogo mostra a definição em vigor de cada papel apenas em leitura, e edita-a em **Configurações → Motor de agentes**.
- **Agentes personalizados** — agentes que adicionou você mesmo, com o nome `custom-*`.

Cada entrada do catálogo mostra para que serve o agente; os agentes personalizados mostram também o seu modelo predefinido, enquanto os papéis de base correm com o fornecedor e o modelo definidos em **Configurações → Motor de agentes**. Em qualquer caso, pode ver toda a equipa antes de ligar os agentes a uma cadeia de perfil.

## Adicionar um agente personalizado

Como vivem no seu repositório, os agentes personalizados são **ativos de equipa que se podem committar**: faça commit do ficheiro e toda a equipa fica com o agente. Isto espelha a ideia central de toda a secção Agentes —

> **As definições dos agentes personalizados são partilhadas (vivem no repositório e viajam com o `git`); os papéis de base são definidos pelo runtime do Core. A configuração dos modelos é por projeto (vive nos perfis).**

## Pôr um agente personalizado a trabalhar

O fluxo típico:

## Acompanhar o desempenho dos perfis

A secção Agentes tem também um separador **Utilização** — uma análise por perfil de quantos jobs correram sob cada perfil numa janela selecionada. É uma forma rápida de confirmar que a sua divisão `fast`/`max` está mesmo a ser usada como pretendia, e de detetar para que perfil a sua equipa tende a gravitar.

## Resumo de toda a secção

- Os **Agentes** são os membros especializados da equipa — o trio partilhado mais especialistas e os seus agentes personalizados. ([Conheça os agentes](meet-the-agents))
- Os **Perfis** empacotam que agentes correm, com que modelos e como as tarefas são encaminhadas — selecionados por rail no lançamento. O perfil default é a escolha equilibrada do dia a dia. ([Perfis e a predefinição equilibrada](profiles-and-the-balanced-default))
- Os **Modelos** são afinados por agente, por projeto, dentro dos perfis — construa `fast` e `max` à medida do trabalho. ([Personalizar modelos por agente](customizing-models-per-agent))
- O **catálogo** mostra todos os agentes, e o namespace `custom-*` permite-lhe fazer crescer a equipa — definições partilhadas, configuração por projeto.
