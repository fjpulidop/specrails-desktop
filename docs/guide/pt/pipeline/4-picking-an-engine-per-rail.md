# Escolher um motor por rail

## Quando o seletor aparece

O **seletor de motor** vive no cabeçalho do rail, mesmo ao lado do controlo de modo. Só aparece quando o projeto tem **mais do que um** fornecedor instalado.

> **Projetos com um só fornecedor comportam-se exatamente da mesma forma.** Se um projeto tem só um motor, não aparece nenhum seletor e nada muda na escolha de fornecedor — corre simplesmente nesse motor. O seletor existe puramente para projetos com vários fornecedores.

Quando aparece, a sua escolha é **por rail e por lançamento** — rails diferentes podem correr motores diferentes, e a sua escolha é lembrada por projeto (assumindo por default o motor primário do projeto).

## Como escolher um motor

O motor selecionado corre todas as fases do pipeline desse rail. Se a CLI do motor escolhido não estiver instalada, o lançamento falha de imediato — nada é criado. Instale a CLI em falta e tente de novo.

## Em que cada motor é bom

Os quatro correm o pipeline standard **Implement**:

| Motor | Recorra a ele quando… | Notas |
|--------|--------------------|-------|
| **Claude** | Precisa de custo nativo, interação persistente ou tool policy rigorosa. | Perfis, Freestyle e transformações estruturadas. |
| **Codex** | Prefere o Codex CLI da OpenAI ou quer comparar implementações entre fornecedores. | `codex` ≥ 0.128.0. Sem reporte de custo nativo — a app preenche o custo a partir da sua tabela de preços. Os perfis não se aplicam. |

## Um fluxo de trabalho prático

Os projetos com vários fornecedores brilham quando quer **comparar** ou **afinar custos**:

- **Comparar implementações.** Ponha a mesma spec em dois rails, defina um com Claude e outro com Codex, lance ambos (entre projetos, ou um a seguir ao outro na fila do mesmo projeto) e depois use o botão **Comparar** na página Jobs para comparar os resultados.
- **Defina um default sensato.** Defina o motor que mais usa como primário do projeto para que os rails assumam-no por default, e só mude por rail quando uma spec específica pedir outro.

## Coisas a ter em conta

- **A escolha de fornecedor é imutável depois de criar o projeto** (v1). Escolhe os fornecedores instalados ao adicionar o projeto; não há um toggle nas Definições para acrescentar ou remover um mais tarde.
- **O botão "Abrir CLI de IA" do terminal** também oferece um seletor de fornecedor em projetos com vários fornecedores, caso prefira conduzir uma CLI à mão.

## Para onde ir a seguir

- [Usar o Codex](../integrations/using-codex) — instalar e iniciar sessão.
- [Rails e jobs](rails-and-jobs) — a fila e o fluxo de lançamento.
- [Acompanhar o custo](../analytics/tracking-cost) — repartição de custo por motor.
