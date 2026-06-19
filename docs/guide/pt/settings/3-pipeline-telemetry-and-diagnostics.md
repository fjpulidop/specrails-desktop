# Telemetria do pipeline e diagnóstico

Quando um job do pipeline não corre como esperava, a telemetria dá-lhe um registo detalhado, dos bastidores, do que a CLI de IA fez de facto. Está **desativada por omissão** e é totalmente opcional, por projeto — ative-a apenas quando quiser.

## O que é

A telemetria capta sinais de diagnóstico estruturados (traces, métricas e logs) emitidos pela CLI de IA enquanto executa um job do pipeline. Pense nela como a caixa-preta das suas execuções de pipeline: tempos, uso de tokens e atividade passo a passo, capturados localmente para poder inspecionar um job depois do facto.

Assenta no **OpenTelemetry**, um formato aberto e padronizado — por isso os dados não ficam presos numa caixa proprietária.

## Como ativar

A telemetria é configurada **por projeto**:

1. Abra a página de **Definições** do projeto (a rota de definições por projeto).
2. Encontre o interruptor **Telemetria do pipeline**.
3. Ligue-o.

A partir desse momento, os jobs do pipeline desse projeto passam a registar telemetria. Os outros projetos não são afetados — cada projeto decide por si.

### O que é abrangido

A telemetria aplica-se aos **jobs do pipeline** (as execuções em rail Architect → Developer → Reviewer → Ship que estão em fila). Sessões interativas como o chat e o assistente de configuração ficam intencionalmente de fora — a telemetria destina-se às execuções de pipeline repetíveis e inspecionáveis, não a conversas pontuais.

## Onde ficam os dados

Tudo fica na sua máquina, dentro da sua pasta pessoal (`~/.specrails/`) — nunca no seu repositório. As gravações em bruto são guardadas comprimidas junto do respetivo job, e as gravações mais antigas são automaticamente condensadas em resumos compactos ao fim de uma semana para manter tudo arrumado. Nunca precisa de gerir nada disto à mão.

## Exportar um pacote de diagnóstico

A coisa mais útil que a telemetria desbloqueia é a **exportação de diagnóstico** — um único ZIP que empacota tudo sobre um job para resolução de problemas ou partilha.

Quando um job tem telemetria registada, surge um **botão de exportação** no respetivo cartão de job. Clique nele para descarregar um ZIP que contém:

- **`job-metadata.json`** — a identidade e os parâmetros do job
- **`telemetry.ndjson`** — os sinais registados em bruto
- **`logs.txt`** — a saída de logs capturada
- **`summary.md`** — um resumo legível da execução

Se o projeto usar plugins, o pacote inclui também um instantâneo de quais plugins estavam ativos nesse job.

Este é o pacote a obter quando quer perceber uma execução complicada, guardar um registo ou entregar os detalhes a alguém que o esteja a ajudar a depurar.

## Como desativar

Desligue o interruptor a qualquer momento. Os novos jobs deixam de registar de imediato. Tudo o que já foi capturado fica no disco até ser compactado ou até remover o projeto — nada é enviado para parte nenhuma nem se perde sem você saber.
