# Controlla Specrails da qualsiasi AI (server MCP) {#mcp-server}

Specrails può esporre **se stesso** a qualsiasi assistente AI che parli il [Model Context Protocol](https://modelcontextprotocol.io) — Claude Desktop, Claude Code, Cursor, Cline o un tuo agente. Attivalo, punta il tuo assistente verso Specrails e potrai pilotare l'intera app chiacchierando: *"elenca i miei progetti", "crea una spec per il login social nel progetto API", "lancia il rail 0 e dimmi quando ha finito", "quanto ho speso questa settimana?"*. Il tuo assistente richiama gli strumenti di Specrails dietro le quinte, al posto tuo che clicchi qua e là.

Questa è la direzione opposta rispetto alle funzionalità dei plugin e degli "MCP approvati da me": quelle permettono a Specrails di *usare* altri server MCP; questa permette ad altre app di usare **Specrails**.

## Attivo fin da subito

È **attivo di default** — il server è già in esecuzione la prima volta che apri l'app, senza riavvii e senza toccare nulla. Apri **Impostazioni ▸ MCP** per copiare la configurazione client, o per disattivarlo se non lo vuoi.

Resti tu a controllare *cosa* può fare un'AI esterna tramite una serie di livelli di permesso:

| Livello | Cosa consente | Default |
|---|---|---|
| **Lettura** | Elencare e ispezionare progetti, spec, job, analisi… | Sempre attivo (quando l'MCP è abilitato) |
| **Scrittura** | Creare e modificare spec, cambiare impostazioni e configurazione dei rail | Attivo — deseleziona per limitare |
| **AI-spawn** | Azioni che eseguono un'AI e **costano denaro** (lanciare un rail, generare una spec, inviare un turno di chat) | Attivo — deseleziona per limitare |
| **Distruttivo** | Eliminare progetti/spec/job, fermare il lavoro in corso | Attivo — deseleziona per limitare |

Tutti e quattro i livelli sono concessi fin da subito, quindi un assistente collegato può guidare l'intera app da subito. Deseleziona qualsiasi livello che preferisci tenere per te; se poi il tuo assistente prova a fare qualcosa coperto da quel livello, Specrails rifiuta con un messaggio chiaro che ti indica quale livello riattivare.

## Collega Claude Code o Codex in un passo

Apri **Impostazioni ▸ MCP** e fai clic su **Collega** accanto a Claude Code o Codex, oppure esegui un comando nel terminale:

```bash
specrails-desktop mcp connect --client claude   # o codex
```

Specrails si aggiunge alla configurazione del client, conserva un backup del file, non scrive alcun token di accesso e verifica subito la connessione (vedi quanti strumenti ha trovato). Ripeterlo non fa danni. Poi apri una nuova sessione di Claude Code o Codex. **Copia comando** mostra il comando del client se preferisci eseguirlo tu; per altri assistenti, usa **Copia configurazione**.

Se qualcosa non funziona, esegui `specrails-desktop mcp doctor`. Controlla tutto in una volta (l'app, il file del token di accesso, il bridge e il Node che lo esegue, la voce di ogni client e una connessione reale) e indica la soluzione per ogni problema. Si limita a guardare; non cambia niente. Dopo un aggiornamento di Node (per esempio con Homebrew), ripeti **Collega** se il tuo assistente non trova più Specrails.

**Chiedi prima di spendere** (nello stesso pannello, 0,50 $ per impostazione predefinita) è l'importo oltre il quale un assistente collegato deve chiederti prima di avviare un lavoro a pagamento. Merge, PR ed eliminazioni chiedono sempre. Il tuo assistente riceve un set semplice di 15 strumenti con i prossimi passi già pronti, attesa senza interrogazioni ripetute, risposte nella tua lingua e prompt come *start-my-day*, *review-waiting*, *ship-milestone* e *why-stuck*. Se un tuo vecchio script ha bisogno degli strumenti precedenti, disattiva **Strumenti MCP semplificati** nello stesso pannello; le missioni di Specrails non cambiano.

## Solo per agenti: collegare il tuo client

Quando una persona chiede a un agente di collegarsi, leggi la [guida di collegamento MCP](https://github.com/fjpulidop/specrails-desktop/blob/main/docs/agents/mcp.md). Copre il collegamento con un comando, la registrazione manuale in Claude Code e Codex, la verifica e la risoluzione dei problemi. La sola registrazione non prova il collegamento: completa `initialize`, `tools/list` e una chiamata in sola lettura.

Per una panoramica veloce, l'assistente chiama `specrails_overview`: cosa è in esecuzione, cosa ti aspetta, i fallimenti recenti, la spesa di oggi e CPU e memoria della macchina, in una sola chiamata. `specrails_inbox` legge e risponde alla casella **Da gestire**, `specrails_missions` elenca le tue missioni e invia loro messaggi, `specrails_specs` e `specrails_rails` mostrano backlog e rail di un progetto, `specrails_insights` la tua spesa e i tuoi limiti, e `specrails_wait` aspetta che un'esecuzione finisca invece di chiedere di continuo. Un'esecuzione fallita arriva con la sua diagnosi e la fine del suo log.

Ogni risposta inizia con un breve riepilogo in linguaggio semplice e i possibili passi successivi, con quello consigliato evidenziato, e gli errori dicono cosa è andato storto e se riprovare serve. Prima di qualcosa di irreversibile, o di un lavoro a pagamento oltre il tuo limite, l'assistente ti mostra un'anteprima e ti chiede prima. Il tuo sì vale solo per quell'azione esatta e scade se nel frattempo cambia qualcosa.

Prima di agire, l'assistente può chiedere a `specrails_overview` un riepilogo aggiornato di un progetto: spec, esecuzioni e stato Git. Le sezioni non disponibili sono segnalate esplicitamente; non significano che il progetto sia vuoto. Può anche cercare e leggere il tuo codice sorgente, riga per riga, senza modificarlo.

Ogni sessione MCP esterna mantiene la propria selezione del progetto. In modalità Missione, il progetto predefinito è quello fissato nella conversazione, che cambi dall'interfaccia della missione; una selezione MCP non può sovrascriverlo. Indicare un altro progetto in una chiamata punta a quel progetto di proposito.

## Cosa puoi farci

Qualche ricetta una volta collegato il tuo assistente. È tutto attivo di default; deseleziona **Scrittura** o **AI-spawn** in Impostazioni ▸ MCP se per ora preferisci che si limiti a osservare.

**Trasforma il lavoro degli altri tuoi strumenti in spec.** Se il tuo assistente ha collegati anche GitHub, Jira, Gmail o Slack, può portare il lavoro dentro Specrails al posto tuo:
> *"Prendi le issue GitHub aperte di questa settimana con etichetta 'bug', crea una spec per ognuna nel progetto API e lanciale."*
>
> *"Leggi le ultime email di feedback dei clienti, raggruppale per tema e crea una spec per ogni tema."*

**Pilota automatico notturno.** Lascialo in esecuzione con l'app nella barra di sistema e torna a un resoconto:
> *"Ecco 12 idee. Trasforma ognuna in una spec, lanciale tre alla volta sui rail, tieni d'occhio ogni job e domani dammi un riepilogo di cosa è finito, cosa è fallito e quanto è costato."*

Deseleziona **Distruttivo** e potrà lavorare tutta la notte senza mai eliminare nulla.

**Su tutti i tuoi progetti.** Qualcosa che la dashboard da sola non fa:
> *"Controlla tutti i miei progetti. Dimmi quali hanno spec nel backlog e nessun rail in esecuzione, e avvia in ognuno quella a priorità più alta."*

**Senza mani mentre programmi.** Pilota Specrails dal tuo editor o a voce, senza cambiare finestra:
> *"Lancia il rail 0 con Opus per la spec #42 e dimmi quando ha finito."*

**Chiedi di costi e cronologia.** Le tue analisi, in linguaggio naturale:
> *"Dove ho speso di più in AI questa settimana, per progetto e per modello? Mostrami le cinque spec più costose."*

**Il tuo standup quotidiano.**
> *"Scrivi il mio standup: quali rail hanno girato ieri, cosa è stato completato, cosa è fallito, costo totale — come elenco puntato pronto da incollare in Slack."*

**Capire il codice.** Senza bisogno di un editor:
> *"Quali file ha toccato la spec #38? Riassumi in una riga cosa è cambiato in ognuno."*

Dato che il tuo assistente legge per prima la guida integrata, raramente devi nominare strumenti o spec — descrivi il risultato e lui calcola le chiamate da fare.

## Qualche cosa da sapere

- **Specrails deve essere in esecuzione.** Il server MCP vive dentro l'app, quindi il tuo assistente può raggiungerlo solo finché Specrails è aperto. Grazie all'icona nella barra di sistema, chiudere la finestra lo mantiene attivo in background — solo **Esci** dall'icona (barra dei menu su Mac / barra di sistema su Windows) lo ferma davvero.
- **Le azioni lunghe trasmettono in streaming.** Lanciare un rail o generare una spec restituisce subito il controllo e termina in background; il tuo assistente può "tenerlo d'occhio" e riferirti quando si conclude.
- **Sicurezza.** L'MCP usa un proprio token di accesso, separato da tutto il resto, e ascolta soltanto sulla tua macchina (loopback). Il token non può impersonare la modalità Agente fornendo header di livello, progetto o conversazione: l'agente integrato usa una capacità privata, di breve durata, emessa dal server. Puoi copiare o rigenerare il token con i suoi limiti in qualsiasi momento dal pannello.
- **Non esposto (v1).** Per sicurezza, i client MCP esterni non possono eseguire comandi shell grezzi nel terminale, usare il browser integrato, modificare file nell'app o installare prerequisiti di sistema. La modalità Agente ha un percorso autenticato separato per i comandi in background di lunga durata confermati con il permesso Autonomo; i client esterni non possono ottenerlo abilitando Distruttivo. Tutto il resto che *gestisce* Specrails è disponibile.

Puoi disattivare l'MCP in qualsiasi momento dallo stesso pannello — il tuo assistente perde semplicemente l'accesso e nient'altro cambia.
