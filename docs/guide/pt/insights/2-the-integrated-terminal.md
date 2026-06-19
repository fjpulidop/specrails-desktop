# O terminal integrado

O Specrails tem um terminal a sério mesmo lá dentro — o painel que sobe a partir do fundo da janela, tal como o do VS Code ou do Cursor. Corre a sua shell real, na pasta real do seu projeto, para poder correr `git`, `npm`, testes ou o que precisar sem sair da aplicação.

## Abrir e fechar

A forma mais rápida é pelo teclado: **Cmd+J** (macOS) ou **Ctrl+J** (Windows/Linux) abre e fecha o painel, e dá o foco ao terminal assim que ele aparece, para poder começar a escrever de imediato. Também pode usar a seta na barra de estado.

O painel tem três estados:

- **Oculto** — recolhido de lado.
- **Restaurado** — o painel normal, em meia altura.
- **Maximizado** — a ocupar toda a área de trabalho quando precisa de espaço para ler o output.

Minimizar o painel (a seta) **não** interrompe nada — as suas shells continuam a correr em segundo plano. A única coisa que termina mesmo uma sessão é fechá-la (o ícone do caixote do lixo, ou o ✕ de cada separador).

## Várias sessões

Pode ter vários terminais ao mesmo tempo no mesmo projeto — até dez. Cada um ganha o seu separador; pode renomeá-los para que "dev server" e "testes" não se confundam. Todos arrancam na pasta do seu projeto e carregam o perfil da sua shell (`.zshrc`, `.bashrc`, e por aí fora), para que os seus aliases e o PATH sejam exatamente o que esperaria.

E aqui está o mais importante: os seus terminais **sobrevivem à mudança de projetos e de separadores**. O Specrails mantém cada sessão viva e intacta nos bastidores — scrollback, processos em execução, tudo — para que saltar para a secção Analytics e voltar não reinicie a sua shell nem interrompa um comando de longa duração. As sessões só terminam quando as fecha explicitamente (ou quando remove o projeto inteiro).

## Por projeto, e memorizado

Se o painel está aberto, a altura para que o arrastou, que separadores existem — tudo isso fica memorizado **por projeto**. Volte a um projeto e está tal como o deixou.

## As funcionalidades premium

Isto não é uma consola básica. O terminal vem com os mimos que esperaria de um terminal de primeira:

- **Renderização rápida e nítida** via WebGL (com um modo alternativo automático, para nunca falhar), tratamento completo de larguras Unicode e ligaduras de tipos de letra.
- **Pesquisar no scrollback** com **Cmd+F** — ótimo para encontrar aquele erro enterrado 500 linhas acima.
- **Zoom do tipo de letra** com **Cmd+=**, **Cmd+-** e **Cmd+0** para repor.
- **Atalhos da área de transferência** — Cmd+C / Cmd+V para copiar e colar, Cmd+K para limpar — além de um menu de contexto do botão direito.
- **Arrastar e largar caminhos de ficheiros** (na aplicação de desktop): largue um ficheiro sobre o terminal e o seu caminho é inserido, corretamente entre aspas para a sua shell.
- **Redimensionamento suave** — arrastar a altura do painel ou recolher a barra lateral não faz o output tremer.
- **Imagens inline** — terminais que emitem imagens em Sixel ou no estilo iTerm2 mostram-nas mesmo no sítio.
- **Integração com a shell** — o Specrails sabe onde cada comando começa e acaba, por isso consegue acompanhar o seu histórico de comandos e avisá-lo quando um comando de longa duração termina (uma notificação de desktop, com um modo alternativo no browser). Se, por alguma razão, a sua shell não puder ser instrumentada, degrada-se discretamente e avisa-o uma vez.

## Definições

As preferências do terminal vivem em duas camadas: um padrão para toda a aplicação e uma substituição opcional por projeto. A definição por projeto prevalece quando existe, para poder manter um aspeto geral comum e, ao mesmo tempo, afinar um projeto que precise de algo diferente.

## Desligá-lo

O terminal está ligado por predefinição. Se preferir ficar sem ele, pode desativá-lo através das flags `VITE_FEATURE_TERMINAL_PANEL` (cliente) ou `SPECRAILS_TERMINAL_PANEL` (servidor) — defina qualquer uma como `false`. A maioria das pessoas vai simplesmente deixá-lo ligado.
