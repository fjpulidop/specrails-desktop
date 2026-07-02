# Escolher um motor por rail

O Specrails desktop trata o **Claude Code**, o **Codex CLI** e o **Gemini CLI** como motores de primeira classe. Um projeto pode ter um, dois ou os três instalados — e quando há mais do que um, escolhe que motor corre cada rail. Esta página cobre o seletor de motor por rail e quando recorrer a cada um.

## Quando o seletor aparece

O **seletor de motor** vive no cabeçalho do rail, mesmo ao lado do controlo de modo. Só aparece quando o projeto tem **mais do que um** fornecedor instalado.

> **Projetos com um só fornecedor comportam-se exatamente da mesma forma.** Se um projeto tem só um motor, não aparece nenhum seletor e nada muda na escolha de fornecedor — corre simplesmente nesse motor. O seletor existe puramente para projetos com vários fornecedores.

Quando aparece, a sua escolha é **por rail e por lançamento** — rails diferentes podem correr motores diferentes, e a sua escolha é lembrada por projeto (assumindo por default o motor primário do projeto).

## Como escolher um motor

1. Certifique-se de que o seletor de motor do rail está visível (projeto com 2+ fornecedores).
2. Clique nele e escolha **Claude**, **Codex** ou **Gemini**.
3. Lance o rail com **▶ Play**.

O motor selecionado corre todas as fases do pipeline desse rail. Se a CLI do motor escolhido não estiver instalada, o lançamento falha de imediato — nada é criado. Instale a CLI em falta e tente de novo.

## Em que cada motor é bom

Os três correm os pipelines standard **Implement** e **Batch**. Aqui fica um guia prático para escolher:

| Motor | Recorra a ele quando… | Notas |
|--------|--------------------|-------|
| **Claude** | Quer o conjunto completo de funcionalidades: perfis de agentes, Freestyle, reporte de custo nativo, o suporte de ferramentas mais rico. O default para a maioria do trabalho. | O único motor que suporta **perfis de agentes**, **Freestyle** e algumas funcionalidades de spec exclusivas do Claude (Contract Layer, SMASH). |
| **Codex** | Prefere o Codex CLI da OpenAI ou quer comparar implementações entre fornecedores. | `codex` ≥ 0.128.0. Sem reporte de custo nativo — a app preenche o custo a partir da sua tabela de preços. Os perfis não se aplicam. |
| **Gemini** | Quer o Gemini CLI da Google, telemetria nativa ou uma execução mais barata para specs de rotina. | `gemini` ≥ 0.11.0 (defina `GEMINI_API_KEY`). Telemetria OTLP nativa. Os perfis não se aplicam. |

### As funcionalidades exclusivas do Claude

Algumas coisas só funcionam em rails Claude — escolha o Claude se precisar delas:

- **Perfis de agentes** — encaminhamento de modelo por agente. Em rails Codex ou Gemini a execução usa sempre o modo legado e qualquer perfil selecionado é **ignorado**. O seletor de perfil fica escondido nos motores que não são Claude.
- **Freestyle** — o modo autónomo que ignora o pipeline. O segmento `Freestyle` e o seu seletor de modelo Haiku/Sonnet/Opus só aparecem quando o motor do rail é o Claude.
- **Contract Layer e SMASH** — funcionalidades de refinamento de spec exclusivas do Claude (são opções de Add Spec, não opções de rail, mas aplica-se a mesma restrição).

Se um projeto mistura motores, a barra lateral direita só mostra as secções que **todos** os fornecedores instalados suportam — por isso a secção **Agentes** desaparece por completo num projeto que inclua qualquer fornecedor que não seja Claude, porque os perfis são específicos do Claude.

## Um fluxo de trabalho prático

Os projetos com vários fornecedores brilham quando quer **comparar** ou **afinar custos**:

- **Comparar implementações.** Ponha a mesma spec em dois rails, defina um com Claude e outro com Codex, lance ambos (entre projetos, ou um a seguir ao outro na fila do mesmo projeto) e depois use o botão **Comparar** na página Jobs para comparar os resultados.
- **Afinar custos por spec.** Corra specs de alto risco no Claude com um perfil `max`; corra specs de limpeza de rotina no Gemini para poupar no gasto. Filtre `/analytics` por motor para ver a repartição.
- **Defina um default sensato.** Defina o motor que mais usa como primário do projeto para que os rails assumam-no por default, e só mude por rail quando uma spec específica pedir outro.

## Coisas a ter em conta

- **A escolha de fornecedor é imutável depois de criar o projeto** (v1). Escolhe os fornecedores instalados ao adicionar o projeto; não há um toggle nas Definições para acrescentar ou remover um mais tarde.
- **O custo é sempre acompanhado**, mesmo para motores sem reporte de custo nativo — a app recorre a uma tabela de preços para que as execuções de Codex e Gemini apareçam na mesma nas [analytics](../analytics/tracking-cost).
- **O botão "Abrir CLI de IA" do terminal** também oferece um seletor de fornecedor em projetos com vários fornecedores, caso prefira conduzir uma CLI à mão.

## Para onde ir a seguir

- [Usar o Codex](../integrations/using-codex) — instalar e iniciar sessão.
- [Usar o Gemini](../integrations/using-gemini) — instalar, `GEMINI_API_KEY`, telemetria.
- [Rails e jobs](rails-and-jobs) — a fila e o fluxo de lançamento.
- [Acompanhar o custo](../analytics/tracking-cost) — repartição de custo por motor.
