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

Nos bastidores, a instalação é *cirúrgica e aditiva*: só acrescenta entradas à configuração MCP nativa do provider escolhido (e, em algumas instalações Claude, um fragmento em `.claude/agents/`). Nunca reescreve toda a configuração e faz rollback limpo se a verificação falhar.

## Gerir plugins instalados

- **Saúde.** Cada plugin tem uma verificação de saúde a pedido. Um plugin que instala bem mas que mais tarde não consegue arrancar é marcado como **Degradado** — não bloqueia os seus rails, apenas verá o selo e um motivo.
- **Desinstalar.** Remover um plugin elimina cirurgicamente apenas as entradas que lhe pertencem, deixando o resto da sua configuração intacto.
- **Órfãos.** Se os ficheiros de um plugin ficarem para trás sem o estado adequado (por exemplo, após uma alteração interrompida), aparece como **Órfão** e pode limpá-lo com um clique.

## Como os plugins surgem no seu trabalho

- **Rails.** Antes de um rail correr, o Specrails verifica quais os plugins instalados e saudáveis e disponibiliza essas ferramentas ao agente para esse trabalho. Um plugin degradado é simplesmente ignorado nessa execução — o rail é lançado normalmente. Cada trabalho regista um instantâneo de quais os plugins que estavam ativos, que pode consultar na exportação de diagnóstico do trabalho.
- **Chat.** O chat recolhe automaticamente a configuração MCP do seu projeto, por isso os plugins instalados também ficam disponíveis aí.
- **Configuração.** Os plugins são ignorados enquanto um projeto ainda está a ser configurado — entram em ação assim que o projeto fica pronto.

## Notas sobre providers

Os plugins têm consciência do provider. O Serena suporta Claude via `.mcp.json`, Codex via `codex mcp add` com `CODEX_HOME` isolado por projeto e Kimi via `.kimi-code/mcp.json`. Um plugin só aparece se o manifesto declarar o provider; por isso Serena não é oferecido para Gemini. O cartão Jira é agnóstico ao provider.

## Ficheiros reservados

Os plugins gerem a configuração MCP nativa do provider, estado em `.specrails/plugins/` e, apenas quando Claude precisa, fragmentos em `.claude/agents/custom-<plugin>.md`. As entradas Kimi ficam em `.kimi-code/mcp.json`; a app não escreve fragmentos exclusivos de Claude para Kimi nem sobrescreve configurações às cegas.
