# Personalizzare i modelli per agente

La cosa più utile in assoluto che i profili ti permettono di fare è **scegliere il modello giusto per ogni passaggio**. Un passaggio di pianificazione potrebbe meritare il tuo modello più potente; un passaggio di costruzione di routine potrebbe trovarsi benissimo con qualcosa di più veloce ed economico. I profili ti permettono di esprimere esattamente questo.

È qui che la separazione tra "condiviso" e "per progetto" ripaga:

- Le *definizioni* degli agenti restano condivise in tutta la tua squadra.
- Il *modello con cui gira ciascun agente* viene configurato **per progetto**, all'interno di un profilo, e riguarda solo il tuo progetto.

Cambia un modello e cambi costo e comportamento per quel progetto — senza toccare la configurazione di nessun altro né le istruzioni di base dell'agente.

## Cambiare il modello usato da un agente

In **Agenti → Profili**, seleziona un profilo e apri il suo editor della catena di agenti. Ogni agente nella catena ha un campo modello. C'è anche un modello **orchestratore** che gestisce il coordinamento di alto livello della pipeline.

I valori dei modelli sono alias — per Claude sono `opus`, `sonnet` e `haiku` (dal più capace → al più veloce). Imposta l'alias che desideri per ogni agente:

- Lascia il modello di un agente **vuoto** per ricadere sul default presente nel file dell'agente.
- Impostalo esplicitamente per fare l'override solo per questo profilo.

Salva, e il prossimo rail avviato con quel profilo userà i nuovi modelli. I job già in esecuzione mantengono il loro snapshot.

## Creare profili come `fast` e `max`

Lo schema naturale è un paio di profili con nome a cui ricorri a seconda del lavoro:

**Un profilo `fast`** — per modifiche piccole e a basso rischio, dove vuoi velocità e un conto più leggero:

- Architect: un modello medio o veloce — il piano è semplice.
- Developer: un modello veloce — la modifica è meccanica.
- Reviewer: tienilo solido, ma puoi sfoltire un po' anche qui.

**Un profilo `max`** — per feature spinose e ad alta posta in gioco, dove vuoi che ogni passaggio sia il più affilato possibile:

- Architect, developer e reviewer: il tuo modello più potente su tutta la linea.

### Due modi per costruirne uno

1. **Duplica e ritocca** *(consigliato).* Seleziona il tuo profilo `default`, **Duplicalo**, dai alla copia un nome in kebab-case come `fast` o `max`, poi regola il modello di ciascun agente. Erediti una catena e un routing già collaudati e cambi solo ciò che intendi cambiare.
2. **Parti da zero.** Crea un **Profilo vuoto** e assembla la catena da te. Devi comunque includere il trio di base (`sr-architect`, `sr-developer`, `sr-reviewer`) — la pipeline dipende da tutti e tre — ed esattamente una regola di routing terminale "cattura-tutto", che deve essere l'ultima.

I nomi dei profili sono in kebab-case minuscolo (es. `fast`, `max`, `cheap-and-cheerful`).

## Instradare i task verso agenti specifici

Le **regole di routing** di un profilo decidono quale agente gestisce un task taggato. Ogni regola elenca dei tag di task e un agente di destinazione; vince la prima regola i cui tag corrispondono, e un'unica regola `default: true` alla fine cattura tutto il resto. Solo gli agenti effettivamente presenti nella catena del profilo possono essere destinazioni di routing — l'editor lo impone.

Per l'uso quotidiano non toccherai il routing: la regola "cattura-tutto" manda il lavoro al developer ed è corretto così. Ricorri alle regole per tag quando vuoi, ad esempio, che il lavoro taggato `migration` vada a uno specialista.

## Scegliere il profilo all'avvio

Tutto questo converge all'avvio: nell'intestazione del rail, scegli `fast`, `max` o `default` per ogni rail. Un batch può mescolarli — una piccola correzione su `fast`, una grande feature su `max`, entrambe in esecuzione nello stesso momento. Vedi [Profili e il default bilanciato](profiles-and-the-balanced-default) per il flusso di selezione.

## Una nota sulla sicurezza

Eliminare un profilo è sicuro per il lavoro in corso: i job già avviati con esso mantengono il loro snapshot, e gli avvii futuri semplicemente ricadono lungo l'ordine di risoluzione. Sperimenta in libertà.

## Dove andare adesso

- [Agenti custom e il catalogo](custom-agents-catalog) — aggiungi agenti da inserire nelle tue catene.
