# Controlla Specrails da qualsiasi AI (server MCP)

Specrails può esporre **se stesso** a qualsiasi assistente AI che parli il [Model Context Protocol](https://modelcontextprotocol.io) — Claude Desktop, Claude Code, Cursor, Cline o un tuo agente. Attivalo, punta il tuo assistente verso Specrails e potrai pilotare l'intera app chiacchierando: *"elenca i miei progetti", "crea una spec per il login social nel progetto API", "lancia il rail 0 e dimmi quando ha finito", "quanto ho speso questa settimana?"*. Il tuo assistente richiama gli strumenti di Specrails dietro le quinte, al posto tuo che clicchi qua e là.

Questa è la direzione opposta rispetto alle funzionalità dei plugin e degli "MCP approvati da me": quelle permettono a Specrails di *usare* altri server MCP; questa permette ad altre app di usare **Specrails**.

## Come attivarlo

È **disattivato di default**. Apri **Impostazioni ▸ MCP** e attiva **Abilita MCP**. Fatto — il server si avvia immediatamente, senza riavvii.

Resti tu a controllare *cosa* può fare un'AI esterna tramite una serie di livelli di permesso:

| Livello | Cosa consente | Default |
|---|---|---|
| **Lettura** | Elencare e ispezionare progetti, spec, job, analisi… | Sempre attivo (quando l'MCP è abilitato) |
| **Scrittura** | Creare e modificare spec, cambiare impostazioni e configurazione dei rail | Disattivato — da abilitare |
| **AI-spawn** | Azioni che eseguono un'AI e **costano denaro** (lanciare un rail, generare una spec, inviare un turno di chat) | Disattivato — da abilitare |
| **Distruttivo** | Eliminare progetti/spec/job, fermare il lavoro in corso | Disattivato — da abilitare |

Se il tuo assistente prova a fare qualcosa coperto da un livello disattivato, Specrails rifiuta con un messaggio chiaro che ti indica quale livello attivare. Così puoi partire in sola lettura e aprire esattamente ciò che ti serve.

## Collegare il tuo assistente

Il pannello mostra un blocco di configurazione pronto da incollare. Il percorso più semplice e universale è il **bridge** incluso (`specrails-mcp`): il tuo assistente lo esegue e quello fa da tramite verso Specrails per te. Il bridge legge il token di accesso in locale, quindi **il token non compare mai nella configurazione del tuo assistente**.

In un client come Claude Desktop o Cursor, la configurazione si presenta così:

```json
{ "mcpServers": { "specrails": { "command": "specrails-mcp" } } }
```

I client che supportano i server MCP HTTP remoti possono invece puntare direttamente a `http://127.0.0.1:4200/api/mcp` con il token preso dal pannello.

### Dal terminale: Claude Code, Gemini CLI, Codex CLI

Copia il tuo token da **Impostazioni ▸ MCP ▸ Copia token**, poi:

```bash
# Claude Code
claude mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <il tuo token>"

# Gemini CLI
gemini mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <il tuo token>"

# Codex CLI (stdio — registra il comando bridge mostrato in Impostazioni ▸ MCP)
codex mcp add specrails -- <comando bridge da Impostazioni ▸ MCP>
```

Funziona anche l'header `Authorization: Bearer <token>`. Se hai cambiato la porta dell'app, sostituisci `4200`.

Una volta collegato, il tuo assistente vede circa **18 strumenti** che coprono l'intera app — progetti, spec, rail e job, chat/Explore, agenti, plugin, Jira, loop, l'esploratore del codice, le analisi, le impostazioni — più uno strumento **guida** integrato che legge per primo, così capisce come funziona Specrails senza che tu debba spiegargli nulla.

## Cosa puoi farci

Qualche ricetta una volta collegato il tuo assistente. Parti con la **Lettura** attiva, poi accendi **Scrittura** e **AI-spawn** quando vuoi che crei e lanci davvero il lavoro.

**Trasforma il lavoro degli altri tuoi strumenti in spec.** Se il tuo assistente ha collegati anche GitHub, Jira, Gmail o Slack, può portare il lavoro dentro Specrails al posto tuo:
> *"Prendi le issue GitHub aperte di questa settimana con etichetta 'bug', crea una spec per ognuna nel progetto API e lanciale."*
>
> *"Leggi le ultime email di feedback dei clienti, raggruppale per tema e crea una spec per ogni tema."*

**Pilota automatico notturno.** Lascialo in esecuzione con l'app nella barra di sistema e torna a un resoconto:
> *"Ecco 12 idee. Trasforma ognuna in una spec, lanciale tre alla volta sui rail, tieni d'occhio ogni job e domani dammi un riepilogo di cosa è finito, cosa è fallito e quanto è costato."*

Tieni **Distruttivo** disattivato e potrà lavorare tutta la notte senza mai eliminare nulla.

**Su tutti i tuoi progetti.** Qualcosa che la dashboard da sola non fa:
> *"Controlla tutti i miei progetti. Dimmi quali hanno spec nel backlog e nessun rail in esecuzione, e avvia in ognuno quella a priorità più alta."*

**Senza mani mentre programmi.** Pilota Specrails dal tuo editor o a voce, senza cambiare finestra:
> *"Lancia il rail 0 in modalità Freestyle con Opus per il ticket #42 e dimmi quando ha finito."*

**Chiedi di costi e cronologia.** Le tue analisi, in linguaggio naturale:
> *"Dove ho speso di più in AI questa settimana, per progetto e per modello? Mostrami i cinque ticket più costosi."*

**Il tuo standup quotidiano.**
> *"Scrivi il mio standup: quali rail hanno girato ieri, cosa è stato completato, cosa è fallito, costo totale — come elenco puntato pronto da incollare in Slack."*

**Capire il codice.** Senza bisogno di un editor:
> *"Quali file ha toccato il ticket #38? Riassumi in una riga cosa è cambiato in ognuno."*

Dato che il tuo assistente legge per prima la guida integrata, raramente devi nominare strumenti o spec — descrivi il risultato e lui calcola le chiamate da fare.

## Qualche cosa da sapere

- **Specrails deve essere in esecuzione.** Il server MCP vive dentro l'app, quindi il tuo assistente può raggiungerlo solo finché Specrails è aperto. Grazie all'icona nella barra di sistema, chiudere la finestra lo mantiene attivo in background — solo **Esci** dall'icona (barra dei menu su Mac / barra di sistema su Windows) lo ferma davvero.
- **Le azioni lunghe trasmettono in streaming.** Lanciare un rail o generare una spec restituisce subito il controllo e termina in background; il tuo assistente può "tenerlo d'occhio" e riferirti quando si conclude.
- **Sicurezza.** L'MCP usa un proprio token di accesso, separato da tutto il resto, e ascolta soltanto sulla tua macchina (loopback). Puoi copiare o rigenerare quel token in qualsiasi momento dal pannello.
- **Non esposto (v1).** Per sicurezza, alcune capacità ad alto rischio sono volutamente escluse: eseguire comandi shell nel terminale, il browser integrato, la modifica dei file nell'app e l'installazione dei prerequisiti di sistema. Tutto ciò che *gestisce* Specrails è disponibile; l'accesso diretto alla macchina no.

Puoi disattivare l'MCP in qualsiasi momento dallo stesso pannello — il tuo assistente perde semplicemente l'accesso e nient'altro cambia.
