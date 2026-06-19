# Plugins (Integrações)

A secção **Integrações** é um marketplace por projeto de extras opcionais que ampliam o que a IA consegue fazer. Cada projeto decide de forma independente que plugins quer — instalar um plugin num projeto nunca afeta outro.

Os plugins funcionam registando discretamente um **servidor MCP** (Model Context Protocol) no seu projeto, dando à IA novas ferramentas para invocar durante rails e chat. Não precisa de perceber de MCP para os usar — instale-os e ficam disponíveis na próxima vez que um rail correr.

## O que está disponível hoje

Esta versão inclui **apenas plugins incorporados**: os plugins que pode instalar são os que vêm integrados na app. Não há registo remoto, nem plugins carregados por utilizadores, nem carregamento de código de terceiros — por isso tudo o que está no catálogo é verificado e distribuído com o Specrails.

O plugin de destaque é:

- **Serena** — navegação semântica de código. Dá à IA uma compreensão da sua base de código apoiada por um language server (saltar para a definição, encontrar referências, pesquisa consciente de símbolos) em vez de uma simples correspondência de texto. Ótimo para repositórios maiores ou desconhecidos onde quer que o agente raciocine sobre símbolos reais.

  O Serena requer a ferramenta `uv` no seu `PATH` (corre via `uvx`). A app deteta automaticamente se o `uv` está presente e avisa-o caso esteja em falta.

## Instalar um plugin

1. Abra **Integrações** a partir da barra lateral direita.
2. Encontre o plugin no catálogo. Cada cartão mostra um estado: **Não instalado**, **Instalado**, **Degradado** ou **Órfão**.
3. Clique no plugin para **pré-visualizar a instalação** — isto mostra-lhe exatamente que ficheiros vão mudar antes de qualquer coisa acontecer.
4. Clique em **Instalar**. Verá o progresso em tempo real à medida que tudo é configurado.

Nos bastidores, a instalação é *cirúrgica e aditiva*: só acrescenta as suas próprias entradas ao `.mcp.json` do seu projeto (e, para alguns plugins, um ficheiro de fragmento no namespace protegido `.claude/agents/`). Nunca reescreve a sua configuração por inteiro, e adicionar um segundo plugin nunca pode perturbar o primeiro. Se a instalação não conseguir verificar-se como saudável, é revertida de forma limpa.

## Gerir plugins instalados

- **Saúde.** Cada plugin tem uma verificação de saúde a pedido. Um plugin que instala bem mas que mais tarde não consegue arrancar é marcado como **Degradado** — não bloqueia os seus rails, apenas verá o selo e um motivo.
- **Desinstalar.** Remover um plugin elimina cirurgicamente apenas as entradas que lhe pertencem, deixando o resto da sua configuração intacto.
- **Órfãos.** Se os ficheiros de um plugin ficarem para trás sem o estado adequado (por exemplo, após uma alteração interrompida), aparece como **Órfão** e pode limpá-lo com um clique.

## Como os plugins surgem no seu trabalho

- **Rails.** Antes de um rail correr, o Specrails verifica quais os plugins instalados e saudáveis e disponibiliza essas ferramentas ao agente para esse trabalho. Um plugin degradado é simplesmente ignorado nessa execução — o rail é lançado normalmente. Cada trabalho regista um instantâneo de quais os plugins que estavam ativos, que pode consultar na exportação de diagnóstico do trabalho.
- **Chat.** O chat recolhe automaticamente a configuração MCP do seu projeto, por isso os plugins instalados também ficam disponíveis aí.
- **Configuração.** Os plugins são ignorados enquanto um projeto ainda está a ser configurado — entram em ação assim que o projeto fica pronto.

## Notas sobre providers

Os plugins têm consciência do provider. O Serena e plugins MCP semelhantes resolvem-se para providers que registam MCP através do `.mcp.json` do projeto (Claude e Gemini). Para projetos Codex, os servidores MCP são geridos através da própria configuração global do Codex, por isso as entradas de plugins em **Integrações** são filtradas em conformidade. O cartão do Jira em Integrações é agnóstico ao provider e aparece para toda a gente — consulte o guia do Jira.

## Ficheiros reservados

Os plugins gerem um conjunto pequeno e bem definido de ficheiros no seu projeto: o seu `.mcp.json` (fundido cirurgicamente), algum estado em `.specrails/plugins/` e fragmentos de agente por plugin em `.claude/agents/custom-<plugin>.md`. Estes são ativos de equipa que pode versionar se quiser partilhar uma integração com os seus colegas — a app nunca os sobrescreve às cegas.
