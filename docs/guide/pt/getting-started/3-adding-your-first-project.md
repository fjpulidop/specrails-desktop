# Adicionar o seu primeiro projeto

Um projeto é apenas uma pasta no seu computador que contém uma base de código. Vamos ligar uma.

## Abrir a janela Adicionar projeto

Clique em **Adicione o seu primeiro projeto** no ecrã de boas-vindas (ou no botão **Adicionar projeto** na barra lateral esquerda mais tarde). Aparece uma pequena janela.

## Preencher os detalhes

**Pasta do projeto** *(obrigatório)*

Indique ao specrails a pasta que contém o seu código. Na app de desktop pode clicar no ícone de pasta para navegar e escolher visualmente, ou colar o caminho completo. Deve ser a raiz do seu repositório — a pasta que contém o código e (normalmente) um diretório `.git`.

**Nome do projeto** *(opcional)*

Um rótulo amigável mostrado na barra lateral. Se deixar em branco, o specrails usa o nome da pasta.

> Uma verificação rápida corre em segundo plano para confirmar que as ferramentas necessárias estão presentes. Se faltar algo essencial, o botão **Adicionar** fica desativado e uma ligação **Mais info** dá-lhe os comandos de instalação exatos.

É todo o formulário — clique em **Adicionar** e está feito.

## Os fornecedores de IA são detetados automaticamente

Já não escolhe fornecedores. O specrails deteta cada CLI de IA instalado na sua máquina — **Claude**, **Codex**, **Gemini**, **Kimi** — e todos os projetos podem usá-los todos, sempre. Se instalar um fornecedor novo mais tarde, ele aparece em todo o lado por si próprio na próxima vez que focar a app; sem reconfiguração, sem ajustes por projeto. Se um fornecedor estiver instalado mas sem sessão iniciada, o seu seletor mostra um distintivo subtil *Sem sessão iniciada*.

## A configuração acontece em silêncio

Não há assistente de configuração. No momento em que clica em **Adicionar**, o projeto fica registado e aparece na barra lateral — pode abri-lo de imediato. Em segundo plano, o specrails monta o workspace do projeto (poucos segundos, totalmente offline): um pequeno ponto a pulsar na linha do projeto mostra que está a trabalhar, e desaparece quando tudo está pronto. Se algo falhar para um fornecedor, o projeto continua a funcionar com os restantes — aparece um ponto âmbar e clicar nele tenta de novo.

## O que é instalado — e onde

A configuração é deliberadamente **não invasiva**: o seu repositório permanece intacto. Todos os artefactos do specrails (definições de agentes, comandos, perfis, definições locais) vivem num workspace por projeto sob o seu diretório home, ligado a uma única instalação partilhada do framework que vem com a app. O seu repo nunca é modificado — e quando a app é atualizada, todos os projetos recebem o novo framework automaticamente, de uma vez.

> **Prefere a configuração profunda?** A app inclui de propósito a instalação rápida com templates. Se preferir o fluxo enriquecido por IA (análise da base de código e personas de agentes personalizadas), pode executar `npx specrails-core@latest init` a partir da pasta do projeto num terminal.

## Já está dentro

O painel do projeto fica disponível no momento em que clica em **Adicionar**. Hora da visita guiada — veja [A visita ao painel](the-dashboard-tour).
