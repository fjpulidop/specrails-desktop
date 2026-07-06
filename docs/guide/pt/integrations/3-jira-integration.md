# Integração com o Jira

Quer que as suas specs vivam num **quadro Jira** real em vez de dentro do Specrails? A integração com o Jira apoia as specs de um projeto em issues do Jira, mantém os estados sincronizados à medida que os rails correm e fica fora do caminho no resto do tempo. Cada projeto sincroniza com **o seu próprio** quadro Jira.

## Como funciona (a versão curta)

O Specrails atua como uma **camada de sincronização** entre o Jira e o seu projeto. A ideia central: o seu repositório local de specs continua a ser a fonte canónica que o pipeline lê, e o Specrails é responsável por mantê-lo de acordo com o Jira.

- Quando lança um rail, o Specrails move a issue Jira associada para **Em curso**.
- Quando um trabalho termina, o Specrails transita a issue: em caso de sucesso, move-a para o seu estado de **revisão** mapeado e só chega a **Concluído** quando a PR de entrega é mergeada ou aceita o resultado local; em caso de falha, volta a **A fazer** com um comentário de conclusão que inclui resultado, id da execução, custo, duração e a alteração de estado no Jira.
- Se pedir alterações de seguimento quando a issue Jira já está em revisão, o Specrails tenta continuar a branch da PR aberta existente para esse ticket em vez de criar uma nova branch. Se o seu estado de revisão do Jira não estiver explicitamente mapeado e ainda aparecer localmente como **Em curso**, o Specrails ainda pode continuar a PR quando a chave Jira corresponde ao pull request aberto.
- Periodicamente, o Specrails faz **polling** ao Jira em busca de alterações que alguém tenha feito no quadro e reflete-as de volta nas suas specs.

Todas as escritas de retorno passam por uma fila de saída (outbox) durável e resistente a falhas, por isso um soluço momentâneo do Jira nunca quebra um trabalho — a atualização simplesmente volta a tentar.

## Conectar um quadro

Conecta-se a partir da página **Definições** de um projeto (há também um passo opcional "Configurar Jira" no final do assistente de Adicionar Projeto). O assistente de ligação guia-o através de:

1. **Testar** — introduza o URL e as credenciais do seu Jira, e o Specrails verifica a ligação.
2. **Escolher um projeto** — escolha com que projeto Jira sincronizar.
3. **Mapa de estados (opcional)** — associe os estados do seu fluxo de trabalho Jira aos estados do Specrails, caso a deteção automática precise de uma ajuda (mais abaixo).
4. **Conectar** — feito. As suas specs passam a espelhar esse quadro.

### Autenticação

Esta versão usa autenticação por **colar token** — rápida, no dispositivo e sem qualquer backend envolvido:

- **Jira Cloud:** o e-mail da sua conta mais um token de API.
- **Jira Data Center / Server:** um Personal Access Token (PAT).

O seu token é armazenado **cifrado na sua própria máquina** e nunca a abandona. A app mostra apenas se um token está presente, nunca o token em si.

## Mapeamento de estados

A parte mais complicada de qualquer sincronização com o Jira é fazer corresponder *o seu* fluxo de trabalho aos estados simples do Specrails (A fazer / Em curso / Em revisão / Concluído, mais as variantes de cancelar). O Specrails resolve isto em dois níveis:

1. **O seu mapa de estados explícito**, se definir um no assistente — ganha sempre.
2. **Deteção automática** a partir da categoria de cada estado (novo / em curso / concluído) mais uma correspondência inteligente para estados do tipo cancelar e concluir.

Quando precisa de mover uma issue ao longo de um fluxo de trabalho com transições condicionadas, encontra um caminho válido passo a passo e preenche quaisquer campos obrigatórios (como uma resolução) pelo caminho. Se um estado for genuinamente inalcançável, a operação fica em espera como dead-letter e é-lhe apresentada em vez de falhar silenciosamente — verá um indicador **degradado** e pode tentar de novo.

## Hot-swap: ligar e desligar com segurança

A ligação ao Jira é **por spec**, capturada no momento em que lança um rail — não é um interruptor global de tudo ou nada no quadro. Isso torna-a segura de alternar:

- **Ativar ou desativar** a integração nunca muda de casa as suas specs existentes.
- **Desligar** repõe o seu projeto no comportamento normal de specs locais.
- As specs que já têm uma ligação ao Jira mantêm a sua escrita de retorno; as que não têm ficam intocadas.

Por isso pode experimentar à vontade — ligue, corra uns quantos rails, desligue — sem baralhar o seu quadro nem as suas specs locais.

## No dia a dia

Uma vez conectada, a página de Definições do projeto mostra um **cartão de ligação** onde pode:

- **Sincronizar agora** — forçar um polling imediato em vez de esperar pelo temporizador.
- **Tentar dead-letters de novo** — voltar a correr quaisquer escritas de retorno que tenham ficado presas.
- **Toggle de hot-swap** — pausar/retomar temporariamente a integração.
- **Desligar** — desassociar o quadro de forma limpa.

As specs apoiadas no Jira mostram um **selo com a chave Jira** (como `PROJ-123`) no seu cartão, e ao clicar nele segue de volta para a issue. Também receberá pequenas notificações quando uma sincronização termina, quando um token de autenticação expira (para que o possa renovar) ou quando a integração entra num estado degradado.

## Coisas a ter em mente

- **Polling, não webhooks.** Como o Specrails corre localmente, faz polling ao Jira em busca de alterações em vez de receber notificações push. As alterações aparecem dentro do intervalo de polling, não instantaneamente.
- **Um quadro por projeto.** Projetos diferentes podem sincronizar com quadros diferentes; um único projeto sincroniza com exatamente um.
- **Em conflitos, vence a última escrita** para o caso raro de dois separadores editarem o mesmo rascunho em simultâneo.

## Desligar

Se alguma vez quiser recuar por completo, basta **Desligar** nas Definições. As suas specs voltam ao comportamento apenas local, e os metadados do Jira ficam simplesmente sem uso — nada é destruído.
