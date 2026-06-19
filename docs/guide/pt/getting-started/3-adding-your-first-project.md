# Adicionar o seu primeiro projeto

Um projeto é apenas uma pasta no seu computador que contém uma base de código. Vamos ligar uma.

## Abrir a janela Adicionar projeto

Clique em **Adicionar o seu primeiro projeto** no ecrã de boas-vindas (ou, mais tarde, no botão **Adicionar projeto** na barra lateral esquerda). Aparece uma pequena janela.

## Preencher os dados

**Pasta do projeto** *(obrigatório)*

Aponte o specrails para a pasta que contém o seu código. Na app de desktop pode clicar no ícone de pasta para navegar e escolhê-la visualmente, ou colar o caminho completo. Esta deve ser a raiz do seu repositório — a pasta que contém o seu código e (normalmente) um diretório `.git`.

**Nome do projeto** *(opcional)*

Uma etiqueta amigável mostrada na barra lateral. Se a deixar em branco, o specrails usa o nome da pasta.

**Fornecedores**

Escolha que fornecedor(es) de IA este projeto deve usar. O specrails mostra-lhe os que detetou na sua máquina:

- 🤖 **Claude**
- ⚡ **Codex**
- ✨ **Gemini**

Os fornecedores que não encontrou aparecem a cinzento e marcados como *não encontrado* — instale e inicie sessão num deles e volte a abrir a janela. Por predefinição, todos os fornecedores disponíveis ficam pré-selecionados, mas pode desmarcar até ficar apenas com o que pretende. Se escolher mais do que um, o **primeiro** torna-se o fornecedor predefinido do projeto; mais tarde poderá escolher por tarefa.

> Uma verificação rápida corre em segundo plano para confirmar que as ferramentas necessárias estão presentes. Se faltar algo essencial, o botão **Adicionar** permanece desativado e uma ligação **Mais informações** dá-lhe os comandos de instalação exatos.

Clique em **Adicionar** para continuar.

## Uma configuração que corre em segundos

Se a pasta já tiver o specrails configurado, está concluído — o projeto aparece instantaneamente na sua barra lateral.

Se for um projeto novo, corre um breve **assistente de configuração**. Tem três passos:

1. **Configurar** — confirme o essencial para cada fornecedor que escolheu.
2. **Instalar** — o specrails prepara o projeto automaticamente. Esta é a instalação *rápida*: agentes de template prontos a usar, instalados em segundos. Vai ver um log em direto enquanto corre.
3. **Concluído** — um resumo a confirmar que está tudo pronto.

Num projeto com vários fornecedores, a instalação corre uma vez por fornecedor, um a seguir ao outro, e o passo Concluído mostra um cartão para cada um.

## O que é instalado

A configuração é deliberadamente leve e **não invasiva**. O specrails acrescenta uma pequena quantidade de configuração ao seu projeto para que o pipeline saiba como funcionar:

- Uma pasta `.specrails/` que contém os perfis de agentes e as definições locais do seu projeto.
- Definições de agentes em `.claude/agents/` que dão vida ao pipeline Arquiteto → Developer → Revisor → Ship.

E é só isto — o specrails não reescreve o seu código-fonte durante a configuração, e estes ficheiros podem ser incluídos no commit sem problemas, caso queira partilhar a configuração com a sua equipa.

> **Prefere a configuração aprofundada?** A app traz de propósito a instalação rápida por templates. Se preferir o fluxo enriquecido por IA (análise da base de código e personas de agentes personalizadas), pode executar `npx specrails-core@latest init` a partir da pasta do projeto num terminal.

## Está dentro

Assim que a configuração terminar, o specrails leva-o diretamente para o dashboard do seu projeto. É hora do tour — veja [O tour pelo dashboard](the-dashboard-tour).
