<!-- guide-revision: mission-first-v1 -->

# Escolher um fornecedor e as suas capacidades {#provider-capabilities}

As definições de execução pertencem ao fornecedor escolhido. Um nome de modelo conhecido não implica que todos os fornecedores suportem os mesmos controlos de raciocínio, de saída estruturada ou de aprovação.

## Verifique primeiro a disponibilidade

Autentique a CLI do fornecedor e confirme o seu estado no Specrails. Escolha entre os modelos e os valores de esforço oferecidos pelos controlos desse fornecedor. Uma CLI instalada pode mesmo assim falhar porque a sua sessão, a sua quota ou o serviço remoto não estão disponíveis.

O Claude e o Codex têm adaptadores diferentes. As combinações não suportadas devem falhar antes de um loop começar; por exemplo, não se pode assumir que um passo que exige uma resposta estruturada sem ferramentas funciona com todos os fornecedores.

## Use o nível de controlo certo

A escolha de fornecedor/modelo de um rail controla a sua execução. O loop Freestyle da galeria corre em todos os fornecedores CLI e motores locais; só o Claude acrescenta o chat interativo dentro do job. Os perfis de papéis e o encaminhamento por agente dependem do fornecedor e do workflow do Core que o Desktop instalou no projeto; inspecione a configuração efetiva em vez de assumir que um perfil altera todas as chamadas.

Ao comparar execuções, mantenha a mesma spec, a mesma revisão do repositório e os mesmos critérios de verificação. Trate separadamente o custo reportado, o estimado e o indisponível. Consulte [os perfis](../agents/profiles-and-the-balanced-default) e [a utilização](../insights/analytics-and-cost-tracking).

Num lançamento a partir de uma missão, os passos do loop herdam o fornecedor, o modelo e o esforço da missão, a menos que um agente os substitua explicitamente no editor de loops. As definições gerais gerem as ligações aos fornecedores; o antigo bloco de predefinições do fornecedor e o seletor de Papéis já não são oferecidos.
