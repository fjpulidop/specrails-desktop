# Se o servidor local parar {#server-recovery}

O Specrails executa no seu computador um pequeno servidor que mantém os seus projetos, rails, missões e terminais a funcionar. A aplicação de ambiente de trabalho vigia-o e recupera-o se parar.

## O que acontece quando o servidor para

- **O Specrails reinicia-o por si.** O servidor volta no mesmo endereço e as janelas abertas voltam a ligar-se sozinhas; a barra de estado mostra **A religar** durante alguns segundos.
- **Um aviso explica o que aconteceu**: quando o servidor parou e porquê (um código de saída ou um sinal). O trabalho que estava a decorrer nesse momento pode ter sido interrompido: verifique o seu estado e volte a executá-lo se for preciso.
- **No máximo três reinícios por minuto.** Se o servidor continuar a parar, o Specrails deixa de o reiniciar para não esconder um problema e mostra uma caixa de diálogo. Escolha **Try again** para o iniciar agora, ou feche e volte a abrir o Specrails. Os seus projetos guardados continuam no disco.
- **O arranque seguinte também o explica.** Se o Specrails foi fechado enquanto o servidor estava parado, o aviso aparece da próxima vez que o abrir.

Escolha **Dispensar** no aviso depois de o ler; não voltará a aparecer para essas paragens.

## Reportar um problema {#report-a-problem}

**Reportar um problema** guarda no seu computador um ZIP que ajuda a perceber o que correu mal. Nada é enviado: decide se o partilha e com quem.

Abra-o a partir de:

- **Reportar um problema** no aviso,
- **Definições ▸ Sobre ▸ Reportar um problema**,
- a paleta de comandos (**⌘K**), escrevendo *reportar um problema*.

Antes de guardar, a janela lista cada ficheiro do relatório e mostra o seu conteúdo. O ZIP contém exatamente o que vê:

| Ficheiro | Conteúdo |
| --- | --- |
| `README.txt` | O que é o relatório e o que contém cada ficheiro |
| `system.json` | Versões da aplicação e do Core, sistema operativo, memória |
| `settings.json` | Definições da aplicação, sem tokens, chaves, palavras-passe, valores de ambiente nem cabeçalhos |
| `server.log` | Saída do servidor em execução desde que arrancou |
| `sidecar-stderr.log` | Saída de erros recente do servidor, incluindo execuções anteriores que pararam (aplicação de ambiente de trabalho) |
| `desktop.log` | Quando o servidor arrancou, parou e foi reiniciado (aplicação de ambiente de trabalho) |
| `crashes.json` | Cada paragem inesperada, com as últimas linhas de erro |
| `stalls.json` | Momentos em que o servidor não respondia |

Tokens, chaves de API, palavras-passe, chaves privadas e credenciais em URL são substituídos por `[REDACTED]` e a sua pasta pessoal aparece como `~`. Mesmo assim, leia os ficheiros antes de os partilhar: pode aparecer o nome de um projeto ou ficheiro que considere privado.

## Capacidade de resposta {#responsiveness}

O painel **Recursos** da barra de estado mostra também a **Capacidade de resposta**: quantas vezes o servidor não conseguiu responder durante 200 ms ou mais, o mais longo desses momentos e o que estava a fazer. Bloqueios longos e frequentes justificam um relatório.
