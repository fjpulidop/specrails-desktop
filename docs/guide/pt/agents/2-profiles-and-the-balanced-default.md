# Perfis e a predefinição equilibrada

Um **perfil** é uma receita guardada para uma execução do pipeline. Responde a três perguntas num só lugar:

1. **Que agentes** participam (o trio de base, mais quaisquer especialistas ou agentes personalizados).
2. **Que modelo** cada agente usa.
3. **Como as tarefas são encaminhadas** para esses agentes.

Vai encontrar os perfis na secção **Agentes** de qualquer projeto (barra lateral direita → **Agentes** → separador **Perfis**).

## A predefinição equilibrada

Logo à partida, um projeto resolve para um perfil **default** sensato. Inclui o trio de base — `sr-architect`, `sr-developer`, `sr-reviewer` — e encaminha todas as tarefas para o developer através de uma única regra do tipo apanha-tudo. Os modelos estão equilibrados para o trabalho do dia a dia: um modelo capaz onde importa, sem recorrer à opção mais cara em cada passo.

Se o seu projeto já tinha os modelos dos agentes configurados à maneira antiga (no frontmatter dos ficheiros dos agentes), o botão **Migrar** lê esses valores e cria um perfil `default` que reflete exatamente o comportamento atual — sem perdas, nada muda até que decida afiná-lo.

O ponto principal: **não precisa de criar um perfil para usar o Specrails.** A predefinição simplesmente funciona. Os perfis são a forma de ir mais além.

## Como um perfil é escolhido para uma execução

Quando lança um rail, o Specrails escolhe um perfil por esta ordem:

1. **A sua escolha explícita** no cabeçalho do rail (veja abaixo).
2. A sua **preferência por developer** — um perfil que tenha marcado como a sua predefinição pessoal para este projeto (é local a si e não é committado).
3. O perfil **`default`** do projeto.

O perfil é capturado num *snapshot no lançamento*, por isso cada rail num batch pode correr um perfil diferente, e alterar um perfil mais tarde nunca reescreve jobs que já tenham começado.

## Selecionar um perfil por rail

A seleção do perfil acontece mesmo onde lança — no **cabeçalho do rail**, através do seletor de perfis.

- Escolha um perfil no menu pendente para o usar **apenas neste lançamento**.
- Use a opção de persistir para tornar um perfil a escolha permanente do rail daí para a frente.

É todo o fluxo: escolha um perfil, lance, pronto. Rails concorrentes no mesmo batch podem levar cada um o seu próprio perfil, por isso uma correção rápida e uma funcionalidade pesada podem correr lado a lado com configurações diferentes.

## Quando a secção Agentes está silenciosa

Os perfis são separados por provider. Claude e Kimi suportam perfis/roles;
Codex e Gemini usam modo legacy. Em projetos mistos o mesmo nome não atravessa
Claude/Kimi. Kimi permite roles manuais, mas generation, smoke test e AI
Refine do Agent Studio são recusados antes do spawn. Kimi exige
`specrails-core` 4.12.0 ou mais recente.

## Para onde ir a seguir

- [Personalizar modelos por agente](customizing-models-per-agent) — construa perfis `fast` e `max`.
- [Agentes personalizados e o catálogo](custom-agents-catalog) — veja e expanda a equipa.
