# Política de segurança dos agentes {#agent-safety-policy}

Os agentes de rails, loops e missões trabalham sem perguntar a você antes de cada comando. Isso os deixa rápidos, mas algumas ações são arriscadas demais para ficar a cargo do agente. O Specrails verifica cada chamada de ferramenta de um agente **Claude** contra uma lista curta de proibições, antes da execução, e bloqueia as que estão na lista.

## O que é bloqueado e por quê

| Bloqueado | Por quê |
|---|---|
| **Push forçado** (`--force`, `--force-with-lease`, `+branch`, `--mirror`) | Reescreve o histórico compartilhado. |
| **Push para a branch de integração** (branch padrão do projeto, `main` ou `master`) | O trabalho só chega lá por um pull request que uma pessoa faz merge. |
| **Exclusão de uma branch remota** | As branches são limpas com a entrega, não pelo agente. |
| **`git reset --hard` fora da branch do run** | Permitido na branch do run, dentro do run; em qualquer outro lugar pode destruir o trabalho de alguém. |
| **Exclusão de branches** protegidas, da própria do run ou fora do run | Pelo mesmo motivo. |
| **Merge de um pull request** (`gh pr merge`) | Quem decide o que entra é você. |
| **Exclusões recursivas fora do run** (`rm -rf`, `rimraf`, `find -delete`, `git clean -f`) | Só o worktree do run e pastas temporárias podem ser esvaziados. Uma exclusão cujo alvo não dá para saber (`rm -rf "$DIR"`, `xargs rm -rf`) também é bloqueada. |
| **Ler ou escrever credenciais**: `~/.ssh`, `~/.aws`, `~/.gnupg`, chaveiros e o cofre de segredos do Specrails | Agentes nunca precisam das suas chaves. |
| **Alterar os arquivos da própria política** | Para que um agente não possa desativá-la. |

Todo o resto funciona como antes.

## O que você vê

- O agente recebe o motivo e segue sem essa ação, ou explica do que precisa.
- O log do run ou a missão mostra uma linha **Bloqueado pela política do Specrails** com a regra e o motivo.
- A [auditoria de ações dos agentes](3-reviewing-a-delivery.md) registra cada bloqueio (origem `policy-hook`) ao lado da ação tentada.

## Onde se aplica

- Rails isolados, loops e sessões de Intent (cada um no próprio worktree) e missões.
- **Só Claude.** O Codex não tem um equivalente que o Specrails possa instalar sem alterar a sua própria configuração do Codex; nos runs do Codex, o Specrails continua verificando a branch e a entrega depois de cada turno.
- Runs que trabalham direto na pasta do seu projeto (sem isolamento) não estão cobertos: o Specrails nunca escreve na sua própria cópia.
- macOS e Linux. No Windows a política ainda não é instalada.

## Bom saber

- É um guarda-corpo, não uma sandbox. Barra os comandos destrutivos comuns; não torna seguro um agente hostil.
- Se a própria verificação falhar, a chamada segue, a menos que pareça algo da lista: aí é bloqueada. Uma verificação quebrada nunca para todos os agentes.
- Para desativá-la numa emergência, inicie o Specrails com `SPECRAILS_AGENT_POLICY_HOOK=false`.
