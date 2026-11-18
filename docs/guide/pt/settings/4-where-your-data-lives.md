# Onde ficam os seus dados

Versão curta: **o Specrails mantém os seus repositórios impecáveis.** Quando aponta a aplicação para um dos seus projetos, ela não se instala lá dentro, não espalha ficheiros de configuração por todo o lado nem reescreve nada que não lhe tenha pedido. O seu código continua a ser seu, e limpo.

## O seu repositório continua limpo

Os ficheiros do próprio Specrails — as suas bases de dados, o estado por projeto, as definições de agentes, as configurações, a telemetria, os resumos e tudo o mais de que precisa para funcionar — vivem todos num único lar arrumado, dentro da sua pasta pessoal:

```
~/.specrails/
```

Essa pasta é o workspace privado da aplicação. É onde ficam o registo de projetos, as bases de dados por projeto, as ferramentas integradas e toda a parte operacional. Os seus repositórios de código nunca são usados como depósito para nada disto.

Isto significa que:

- O `.gitignore` do seu repositório **não** é reescrito pela aplicação.
- O seu repositório não fica cheio de configurações de ferramentas nem de diretórios de estado ocultos.
- Remover um projeto do Specrails não deixa nenhuma trapalhada no seu código.

Se já usou ferramentas que, em silêncio, adicionavam pastas e ficheiros por todo o projeto, isto é um afastamento deliberado dessa prática. O Specrails foi construído para que apontá-lo a um repositório seja um **não-acontecimento** para o histórico git desse repositório.

## A única coisa que *é* commitada — por desenho

Há exatamente uma exceção intencional, e é o cerne da ferramenta: **as suas specs OpenSpec.**

As specs vivem no seu repositório, em:

```
openspec/
```

Isto é de propósito. As suas specs são um **entregável** — um registo versionado e revisável daquilo que decidiu construir e porquê. Pertencem ao lado do seu código, controladas no git, visíveis nos pull requests, partilhadas com a sua equipa. É esse o valor: as specs não são estado descartável de rascunho, são parte do histórico do seu projeto.

Portanto, a regra é simples e honesta:

- **`openspec/`** → vive no seu repositório, commitado, por desenho.
- **Tudo o resto de que o Specrails precisa** → vive em `~/.specrails/`, fora do seu caminho.

## Porque funciona assim

O Specrails executa as ferramentas de IA a partir do seu próprio workspace privado (em `~/.specrails/`) e só volta ao seu repositório real para aquilo que genuinamente precisa de o tocar — ler o seu código e escrever as specs que pediu. As ferramentas, as definições da framework e a contabilidade ficam todas na pasta pessoal da aplicação.

A conclusão, para si: pode adicionar um projeto, executar pipelines, explorar specs e experimentar com a confiança de que a árvore de trabalho e o histórico git do seu repositório só mudam de formas que esperaria — as suas specs commitadas e o código que os seus pipelines escrevem. Mais nada se infiltra.

## Remover um projeto

Quando remove um projeto do Specrails, a aplicação limpa o seu próprio estado por projeto dentro de `~/.specrails/`. As specs já commitadas no seu repositório ficam onde pertencem — no seu repositório — porque são suas.

## Worktrees de execuções mantidos no disco {#retained-worktrees}

Cada execução de um rail trabalha no seu próprio worktree Git em `~/.specrails/projects/<projeto>/worktrees/`. Quando uma execução termina, o Specrails remove esse worktree, mas só se conseguir provar que nada se perde. Se não conseguir (alterações sem commit, ficheiros que só existem lá ou uma remoção que falhou), mantém-no. Com o tempo vão-se acumulando.

**Definições ▸ Armazenamento** lista-os para todos os projetos. Também pode lá chegar a partir do popover **Recursos** da barra de estado. Cada worktree mostra o seu tamanho (medido em segundo plano), há quanto tempo está sem uso, a sua PR e o que se perderia ao removê-lo:

- **Nada a perder**: sem alterações sem commit, e cada ficheiro ignorado é regenerável (`node_modules`), uma ligação ou idêntico ao mesmo ficheiro no seu checkout principal (um `.env` copiado, por exemplo). Todos os commits da sua branch estão num remoto ou noutra branch, ou a sua entrega foi integrada.
- **À sua espera**: algo ainda precisa de si. Cada motivo é indicado: alterações sem commit, ficheiros ignorados que só existem lá, commits só nesta branch, uma entrega que espera a sua decisão, atividade recente (a última hora) ou o Git não conseguiu verificá-lo. Um worktree que o Git não consegue verificar nunca é considerado limpo.

Selecione worktrees e escolha **Remover**. A confirmação indica quanto espaço recupera e o que acontece às branches:

- Por predefinição as branches são **mantidas**, por isso os seus commits continuam disponíveis.
- Com **Eliminar também as branches que não contêm nada de novo**, uma branch só é eliminada se não tiver nada a perder e só se ainda apontar para o commit verificado pelo Specrails.

Os worktrees com alterações sem commit ou ficheiros que só existem lá não podem ser selecionados. Primeiro faça commit desse trabalho, copie-o ou descarte-o. Um worktree que pertence a uma sessão Intent aparece na lista, mas é tratado a partir da sua sessão. Imediatamente antes da remoção, cada worktree é verificado de novo: se algo mudou depois de ter confirmado, é mantido e o resultado explica porquê. Os processos que ainda corriam num worktree removido (um servidor de desenvolvimento, por exemplo) são parados.
