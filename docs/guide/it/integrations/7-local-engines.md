# Motori di IA locali

Esegui Specrails su modelli che ospiti tu stesso — Ollama, llama.cpp, LM Studio, vLLM o qualsiasi server che parli l'API chat-completions di OpenAI. Una volta collegato, un endpoint locale è un motore come gli altri: compare nell'intestazione del rail, in Aggiungi spec (Quick ed Explore), nella chat laterale e nelle missioni dell'agente.

## Collegare un endpoint

1. Apri **Impostazioni ▸ Agenti Specrails ▸ Connessioni provider** e scegli **Aggiungi motore locale**.
2. Inserisci un id, l'URL base (per esempio `http://127.0.0.1:11434/v1`) e, se il server richiede una chiave, il **nome della variabile d'ambiente** che la contiene. La chiave non viene mai salvata: Specrails la legge dall'ambiente dell'app all'avvio di ogni esecuzione.
3. Premi **Prova connessione**. La spia diventa verde quando il server risponde e vengono elencati i modelli serviti. Scegli un modello predefinito.
4. **Salva**. Il motore è subito disponibile, senza riavvio.

> Avviare l'app da Finder, Dock o menu Start non eredita gli export della shell. Se la scheda indica che la variabile *non è impostata nel processo dell'app*, impostala a livello di sistema o avvia l'app da un terminale che la conosce. I server senza chiave non hanno bisogno di nulla.

Ogni connessione ha anche l'impostazione **Loop dell'agente**. **Compatto** (predefinito) guida i modelli piccoli con passi brevi e strutturati: è ciò che permette a un modello da 7–14B di superare l'implement; **Libero** è il classico loop agentico per modelli potenti (~30B+). Imposta la **finestra di contesto** alla dimensione reale del server così Specrails compatta prima che il server rifiuti una richiesta.

## Cosa ottieni

- Rails (implement, batch, freestyle, loop personalizzati), Explore e spec Quick, chat e missioni girano sul modello locale.
- Le missioni mantengono i loro strumenti Specrails e i tuoi server MCP esterni.
- Le sessioni riprendono tra un turno e l'altro; i job interattivi funzionano.
- Il costo è onesto: i token vengono registrati, il costo resta *sconosciuto* a meno che tu non inserisca tariffe (allora è contrassegnato come *stimato*).

Non disponibile sui motori locali: profili agente e ruoli personalizzati, arricchimento SMASH / Contract Layer, allegati e telemetria della pipeline. Il Project Builder funziona in modalità solo-output (senza strumenti); il suo contratto di blueprint è rigido, quindi usa un modello capace.

> Le missioni richiedono una **finestra di contesto ampia** sul server (64k token o più): il prompt dell'operatore più gli schemi degli strumenti Specrails sono grandi. Chat ed Explore vanno bene a 32k. Se un turno fallisce con *exceeds the available context size*, aumenta la finestra (Ollama `OLLAMA_CONTEXT_LENGTH`, llama.cpp `-c`, LM Studio *Context Length*).

## Hai solo un motore locale?

Niente da configurare. Specrails offre i motori che la tua macchina può davvero eseguire e sceglie il predefinito con un'unica regola ovunque: una CLI installata (Claude → Codex → Gemini → Kimi), altrimenti il primo motore locale il cui endpoint risponde. Su una macchina con il solo endpoint locale, rail, Add Spec, chat, **missioni dell'agente e Project Builder** partono su di esso — nessun selettore da toccare. Un motore con il server spento semplicemente non viene offerto finché non risponde di nuovo. Le missioni esistenti mantengono il motore con cui sono state create; il selettore permette comunque di cambiarlo.

## Scegliere il modello

La qualità dipende dal modello, non da Specrails. Per i rail usa un modello di codice addestrato al tool calling da 30B parametri o più; i modelli instruct piccoli bastano per chat, Explore e spec Quick. Prova **Freestyle** o una sessione Explore prima di affidare un rail implement completo a un modello nuovo.

## Disattivare

Imposta `SPECRAILS_LOCAL_ENGINES=false` nell'ambiente dell'app per nascondere ovunque i motori locali. Le connessioni salvate restano e continuano a valere come provider per ruolo del runtime programmatico.
