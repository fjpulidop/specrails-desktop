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

Dietro le quinte l'installazione è *chirurgica e additiva*: aggiunge voci solo alla configurazione MCP nativa del provider scelto (e, per alcune installazioni Claude, un frammento sotto `.claude/agents/`). Non riscrive mai tutta la configurazione e, se la verifica fallisce, esegue un rollback pulito.

## Gestire i plugin installati

- **Salute.** Ogni plugin ha un controllo di salute su richiesta. Un plugin che si installa correttamente ma in seguito non riesce ad avviarsi viene contrassegnato come **Degradato** — non blocca i tuoi rail, vedrai solo il badge e un motivo.
- **Disinstalla.** Rimuovere un plugin elimina in modo chirurgico solo le voci di sua proprietà, lasciando intatto il resto della configurazione.
- **Orfani.** Se i file di un plugin rimangono indietro senza uno stato corretto (per esempio dopo una modifica interrotta), il plugin appare come **Orfano** e puoi ripulirlo con un clic.

## Come i plugin compaiono nel tuo lavoro

- **Rail.** Prima che un rail venga eseguito, Specrails controlla quali plugin sono installati e integri e rende quegli strumenti disponibili all'agente per quel job. Un plugin degradato viene semplicemente saltato per quell'esecuzione — il rail si avvia comunque normalmente. Ogni job registra uno snapshot di quali plugin erano attivi, che puoi vedere nell'esportazione diagnostica del job.
- **Chat.** La chat eredita automaticamente la configurazione MCP del tuo progetto, quindi i plugin installati sono disponibili anche lì.
- **Setup.** I plugin vengono ignorati mentre un progetto è ancora in fase di configurazione — entrano in gioco una volta che il progetto è pronto.

## Note sui provider

I plugin sono consapevoli del provider. Serena supporta Claude tramite `.mcp.json`, Codex tramite `codex mcp add` con `CODEX_HOME` isolato per progetto e Kimi tramite `.kimi-code/mcp.json`. Un plugin compare solo se il manifesto dichiara il provider; Serena quindi non è offerto per Gemini. La scheda Jira resta indipendente dal provider.

## File riservati

I plugin gestiscono la configurazione MCP nativa del provider, lo stato sotto `.specrails/plugins/` e, solo quando serve a Claude, frammenti sotto `.claude/agents/custom-<plugin>.md`. Le voci Kimi vivono in `.kimi-code/mcp.json`; l'app non scrive frammenti esclusivi di Claude per Kimi e non sovrascrive mai le configurazioni alla cieca.
