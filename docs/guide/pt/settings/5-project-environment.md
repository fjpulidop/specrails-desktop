# Ambiente do projeto

Alguns projetos precisam de uma credencial durante a execução, como `NODE_AUTH_TOKEN` para pacotes npm privados. Em **Configurações do projeto → Ambiente**, adicione os **nomes** das variáveis de que seus rails e loops precisam. O Specrails guarda apenas os nomes, nunca os valores.

## De onde vêm os valores

Quando uma execução começa, o Specrails lê cada nome configurado do ambiente com que foi iniciado. Se você abre o Specrails pelo Dock ou pelo Finder, esse ambiente não inclui o que o seu perfil de shell exporta, então o Specrails também lê os nomes ausentes do seu login shell (por exemplo `~/.zprofile` ou `~/.zshrc`). Mantenha a credencial real no perfil do shell, não no repositório.

A verificação roda em segundo plano quando o projeto abre, quando você altera os nomes e periodicamente depois disso, para que um perfil lento não atrase suas execuções. Os valores ficam na memória apenas para aquele projeto.

## Como ler os indicadores de estado

Cada nome salvo mostra um indicador:

| Indicador | O que significa | O que fazer |
|-----------|-----------------|-------------|
| **Herdada** | O Specrails foi iniciado com a variável. | Nada. |
| **Do login shell** | O Specrails a leu do seu login shell. | Nada. |
| **Não definida** | Seu login shell não a exporta. | Adicione um `export` no perfil do shell. |
| **Tempo do shell esgotado** | Seu login shell demorou demais para iniciar. | Acelere o perfil ou aumente `SPECRAILS_LOGIN_SHELL_TIMEOUT_MS` (padrão de 10 segundos). |
| **Falha ao ler o shell** | O Specrails não conseguiu ler seu login shell. | Corrija o perfil ou abra o Specrails a partir de um terminal. |

Passe o mouse sobre um indicador para ver a explicação. Depois de corrigir o perfil, clique em **Verificar novamente**: não é preciso reiniciar o Specrails.

Se uma execução começar com um nome não resolvido, o log mostra uma linha `[environment]` com a variável e seu estado. A execução começa mesmo assim. O valor nunca aparece no app, nos logs nem nas ferramentas MCP.

No Windows, o Specrails usa apenas o ambiente com que foi iniciado.
