# O que é o specrails

Bem-vindo ao **specrails** — uma app de desktop que transforma um assistente de programação com IA numa verdadeira equipa de software a trabalhar nos *seus* projetos, na *sua* máquina.

Em vez de andar a copiar e colar prompts de um lado para o outro, descreve o que pretende sob a forma de uma **spec**, e o specrails fá-la passar por um pipeline de desenvolvimento completo — desenhando, construindo, revendo e entregando a alteração — enquanto a vê acontecer em direto.

## Desenvolvimento com IA orientado por specs

No coração do specrails está uma ideia simples: **a melhor forma de obter bom código de uma IA é partir de uma spec clara.**

Uma *spec* é uma descrição curta e estruturada de um trabalho concreto — uma funcionalidade, uma correção, um refactor. Pode escrever uma em segundos, ou moldá-la através de um chat guiado que faz as perguntas certas e a redige por si. Cada spec torna-se um **ticket** no quadro do seu projeto, tal como uma tarefa em qualquer gestor de issues.

A partir daí, entrega a spec ao pipeline e deixa a IA fazer o trabalho pesado.

## O pipeline: Arquiteto → Developer → Revisor → Ship

Quando lança uma spec, o specrails fá-la passar por quatro fases, cada uma interpretada por um agente de IA focado:

1. **Arquiteto** — lê a sua spec e o código à volta, e depois planeia a alteração: que ficheiros tocar e qual deve ser a forma da solução.
2. **Developer** — escreve o código propriamente dito, seguindo o plano.
3. **Revisor** — verifica o trabalho em termos de correção e qualidade, apanhando problemas antes de si.
4. **Ship** — finaliza a alteração para que fique pronta a fazer commit.

Vê cada fase à medida que decorre, com logs em direto a fluir diretamente da IA. Nada fica escondido — se algo correr mal, vai ver exatamente onde.

## Projetos

Tudo no specrails está organizado em torno de **projetos**. Um projeto é simplesmente uma pasta no seu computador que contém uma base de código. Pode adicionar tantos projetos quantos quiser e alternar entre eles instantaneamente — cada um guarda as suas próprias specs, histórico de jobs, analytics e definições.

O specrails nunca toca em código que não lhe tenha pedido. Trabalha dentro do seu repositório existente, e é você quem mantém o controlo sobre o que vai para commit.

## Escolha o seu fornecedor de IA

O specrails funciona com as principais CLIs de programação com IA:

- **Claude** (Claude Code)
- **Codex** (Codex CLI)
- **Gemini** (Gemini CLI)

Escolha aquela que já usa — ou instale mais do que uma e escolha por tarefa. Um projeto pode correr num único fornecedor ou em vários ao mesmo tempo, por isso nunca fica preso a um só.

## Porque vai gostar

- **Velocidade sem caos** — as specs mantêm a IA focada, por isso obtém alterações úteis em vez de palpites dispersos.
- **Visibilidade total** — logs em direto, uma vista clara do pipeline e analytics por projeto mostram-lhe exatamente o que aconteceu e quanto custou.
- **A sua máquina, o seu código** — tudo corre localmente sobre o seu repositório real.
- **Tudo num só lugar** — specs, jobs, chat, um terminal integrado e o acompanhamento de custos, tudo numa única janela.

Pronto para começar? A seguir: [Instalação e primeira utilização](installing-and-first-run).
