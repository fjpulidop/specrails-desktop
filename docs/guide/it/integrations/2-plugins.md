# Plugin (Integrazioni)

La sezione **Integrazioni** è un marketplace per progetto di componenti aggiuntivi opzionali che ampliano ciò che l'AI può fare. Ogni progetto decide in autonomia quali plugin vuole — installare un plugin in un progetto non tocca mai gli altri.

I plugin funzionano registrando in modo silenzioso un **server MCP** (Model Context Protocol) nel tuo progetto, dando all'AI nuovi strumenti da richiamare durante i rail e la chat. Non serve capire l'MCP per usarli — installa e saranno disponibili alla prossima esecuzione di un rail.

## Cosa è disponibile oggi

Questa versione è **solo inclusa**: i plugin che puoi installare sono quelli integrati nell'app. Non c'è un registro remoto, non ci sono plugin caricati dagli utenti, né caricamento di codice di terze parti — quindi tutto ciò che trovi nel catalogo è verificato e distribuito con Specrails.

Il plugin di punta è:

- **Serena** — navigazione semantica del codice. Dà all'AI una comprensione del tuo codebase basata su un language server (vai alla definizione, trova i riferimenti, ricerca consapevole dei simboli) invece di una semplice corrispondenza di testo. Ottimo per repository ampi o poco familiari, dove vuoi che l'agente ragioni su simboli reali.

  Serena richiede lo strumento `uv` nel tuo `PATH` (viene eseguito tramite `uvx`). L'app rileva automaticamente se `uv` è presente e ti avvisa se manca.

## Installare un plugin

1. Apri **Integrazioni** dalla barra laterale destra.
2. Trova il plugin nel catalogo. Ogni scheda mostra uno stato: **Non installato**, **Installato**, **Degradato** o **Orfano**.
3. Entra nel plugin per **vedere l'anteprima dell'installazione** — ti mostra esattamente quali file cambieranno prima che succeda qualsiasi cosa.
4. Clicca **Installa**. Vedrai l'avanzamento in tempo reale durante la configurazione.

Dietro le quinte l'installazione è *chirurgica e additiva*: aggiunge soltanto le proprie voci al `.mcp.json` del tuo progetto (e, per alcuni plugin, un file frammento nel namespace protetto `.claude/agents/`). Non riscrive mai integralmente la tua configurazione, e l'aggiunta di un secondo plugin non può mai disturbare il primo. Se l'installazione non riesce a verificarsi come integra, viene annullata in modo pulito.

## Gestire i plugin installati

- **Salute.** Ogni plugin ha un controllo di salute su richiesta. Un plugin che si installa correttamente ma in seguito non riesce ad avviarsi viene contrassegnato come **Degradato** — non blocca i tuoi rail, vedrai solo il badge e un motivo.
- **Disinstalla.** Rimuovere un plugin elimina in modo chirurgico solo le voci di sua proprietà, lasciando intatto il resto della configurazione.
- **Orfani.** Se i file di un plugin rimangono indietro senza uno stato corretto (per esempio dopo una modifica interrotta), il plugin appare come **Orfano** e puoi ripulirlo con un clic.

## Come i plugin compaiono nel tuo lavoro

- **Rail.** Prima che un rail venga eseguito, Specrails controlla quali plugin sono installati e integri e rende quegli strumenti disponibili all'agente per quel job. Un plugin degradato viene semplicemente saltato per quell'esecuzione — il rail si avvia comunque normalmente. Ogni job registra uno snapshot di quali plugin erano attivi, che puoi vedere nell'esportazione diagnostica del job.
- **Chat.** La chat eredita automaticamente la configurazione MCP del tuo progetto, quindi i plugin installati sono disponibili anche lì.
- **Setup.** I plugin vengono ignorati mentre un progetto è ancora in fase di configurazione — entrano in gioco una volta che il progetto è pronto.

## Note sui provider

I plugin sono consapevoli del provider. Serena e i plugin MCP analoghi si risolvono per i provider che registrano l'MCP tramite il `.mcp.json` del progetto (Claude e Gemini). Per i progetti Codex, i server MCP vengono gestiti invece tramite la configurazione globale di Codex, quindi le voci dei plugin in **Integrazioni** vengono filtrate di conseguenza. La scheda Jira nelle Integrazioni è indipendente dal provider e viene mostrata a tutti — consulta la guida di Jira.

## File riservati

I plugin gestiscono un insieme ristretto e ben definito di file nel tuo progetto: il tuo `.mcp.json` (unito in modo chirurgico), un po' di stato sotto `.specrails/plugins/` e i frammenti agente specifici per plugin in `.claude/agents/custom-<plugin>.md`. Questi sono asset di team committabili, se vuoi condividere un'integrazione con i tuoi colleghi — l'app non li sovrascrive mai ciecamente.
