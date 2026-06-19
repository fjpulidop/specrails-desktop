# Conheça os agentes

Quando lança um rail de **Implement**, o Specrails não entrega a sua spec a uma única IA na esperança de que tudo corra bem. Em vez disso, põe a trabalhar uma pequena equipa de *agentes* especializados, cada um com uma tarefa, numa ordem bem pensada. Esta página apresenta quem faz parte dessa equipa e o que cada um faz.

## O trio de base

Todas as execuções do pipeline usam estes três agentes — são a espinha dorsal, e um projeto não consegue lançar um rail sem eles.

| Agente | Função | O que faz |
|--------|--------|-----------|
| **sr-architect** | O planeador | Lê a sua spec, analisa a base de código e produz um plano de implementação concreto — que ficheiros mexer, que forma vai ter a alteração, com o que ter cuidado. Pensa antes de alguém escrever código. |
| **sr-developer** | O construtor | Pega no plano do architect e escreve mesmo o código: ficheiros novos, edições, testes. É aqui que a sua spec se transforma num diff real. |
| **sr-reviewer** | O crítico | Valida o trabalho do developer face à spec e ao plano, deteta regressões e contesta quando algo não está bem. É a barreira de qualidade antes de a alteração ser considerada concluída. |

Pense nisto como **desenhar → construir → rever**, o mesmo ciclo que uma equipa humana cuidadosa seguiria. Cada agente entrega o seu resultado ao seguinte, por isso o developer nunca trabalha às cegas e o reviewer tem sempre a intenção original para comparar.

## Agentes especialistas

Para além do trio, um projeto pode incluir **agentes especialistas** opcionais que tratam de tipos de trabalho específicos. O mais comum que vai encontrar é:

- **sr-merge-resolver** — um agente utilitário que ajuda a desenredar conflitos de merge e a conciliar alterações que se sobrepõem. É opcional: os perfis só o incluem quando o quiser, e nunca bloqueia o pipeline se estiver ausente.

Os especialistas são de adesão voluntária. Um projeto acabado de criar corre apenas com o trio; adicione especialistas (e os seus próprios **agentes personalizados** — veja [Agentes personalizados e o catálogo](custom-agents-catalog)) quando o fluxo de trabalho do projeto o exigir.

## Como as tarefas chegam ao agente certo

Dentro de uma execução, o trabalho é *encaminhado*. Uma tarefa traz tags, e as regras de encaminhamento de um perfil enviam as tarefas etiquetadas para o agente mais indicado para elas — com uma regra final do tipo apanha-tudo que manda o resto para o developer. Para uma utilização normal não precisa de pensar nisto; a configuração predefinida encaminha tudo de forma sensata logo à partida. Quando estiver pronto para direcionar tipos de trabalho específicos para agentes específicos, veja [Personalizar modelos por agente](customizing-models-per-agent).

## Uma ideia importante, já agora

A *definição* de cada agente — as suas instruções, a sua personalidade, o que lhe é permitido fazer — é **partilhada**. Vivem como ficheiros (`.claude/agents/<id>.md`) que viajam com o seu repositório, por isso toda a equipa corre o mesmo architect, o mesmo reviewer.

O que é **por projeto** é a *configuração* por cima: com que modelo cada agente corre, e que combinação de agentes escolhe para um dado rail. É para isso que servem os perfis — e esse é o tema da próxima página.

## Para onde ir a seguir

- [Perfis e a predefinição equilibrada](profiles-and-the-balanced-default) — como a configuração da equipa é empacotada e selecionada.
- [Personalizar modelos por agente](customizing-models-per-agent) — afine o custo e a qualidade.
