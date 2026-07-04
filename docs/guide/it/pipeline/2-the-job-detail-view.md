# La vista Dettaglio job

Clicca su una qualsiasi scheda job nella pagina **Job** e arrivi qui: la cabina di pilotaggio di una singola esecuzione di rail. È costruita attorno a una promessa — **i numeri live che vedi sono reali, mai ipotesi.** Questa pagina ti accompagna tra le fasi, le metriche live, le schede ticket — e il composer che ti permette di **parlare con il job in esecuzione**.

## Il layout

Due pannelli stanno sopra il log completo in streaming; su un job Claude in esecuzione, un composer di chat sta sotto:

```
┌─────────────────────────────────────────────┐
│  Intestazione di stato (icona · durata live · …) │
├─────────────────────────────────────────────┤
│  Intestazione ticket  ( #12  #14  #15 )     │
├─────────────────────────────────────────────┤
│                                             │
│  Log in streaming (auto-scroll · ricerca · …) │
│                                             │
├─────────────────────────────────────────────┤
│  Composer (invia un messaggio al job · …)   │
└─────────────────────────────────────────────┘
```

## Fasi della pipeline

Per i job `Implement` e `Batch`, l'esecuzione attraversa le fasi definite dallo slash command — per impostazione predefinita:

```
Architect ──► Developer ──► Reviewer ──► Ship
```

Ogni fase è un agente specializzato che l'engine del rail invoca nella cartella del tuo progetto:

| Fase | Agente | Cosa fa |
|-------|-------|--------------|
| **Architect** | `sr-architect` | Pianifica l'implementazione. |
| **Developer** | `sr-developer` | Scrive il codice. |
| **Reviewer** | `sr-reviewer` | Revisiona il risultato. |
| **Ship** | (variabile) | Conclusione finale: test, commit, bozza di PR. |

Quale agente gestisce ogni fase lo decide il **profilo agente** del progetto. Il trio di base (`sr-architect`, `sr-developer`, `sr-reviewer`) è sempre presente; le regole di routing in un profilo possono aggiungere agenti o cambiare quale di essi esegue una fase. La barra di avanzamento delle fasi compare solo quando il comando definisce effettivamente delle fasi — i job Freestyle (che bypassano la pipeline) non ne mostrano alcuna.

## Metriche live — oneste per scelta

L'intestazione di stato è il titolo principale. Mostra un'icona di stato, una riga di attività che descrive cosa sta facendo il job *in questo momento*, un conteggio dei passi compiuti e una riga di metriche:

| Metrica | Quando vedi il valore reale |
|--------|------------------------------|
| **Durata** | **Live.** Un ticker da 1 secondo conta in avanti mentre il job è in esecuzione — è l'unico numero davvero live. |
| **Turni** | Derivati in modo incrementale dagli eventi assistant in streaming man mano che arrivano. |
| **Token** | Aggregati in modo incrementale dallo stesso stream (tollera gli eventi privi dei campi di utilizzo). |
| **Costo** | Mostrato come `—` finché il job non termina, poi rivelato come l'autorevole `total_cost_usd`. |

Il principio di progettazione: **nessun numero approssimato o stimato durante l'esecuzione.** La durata è reale perché è semplicemente un orologio. Turni e token vengono accumulati dall'attività realmente trasmessa in streaming. Il costo deliberatamente *non* viene stimato durante l'esecuzione — appare come in attesa e si risolve solo nel suo valore finale e autorevole quando il provider lo riporta all'uscita del job. Se un numero sembra in attesa, è intenzionale — ti viene mostrata la verità, non una proiezione.

L'etichetta e l'icona dell'intestazione corrispondono allo stato del job, e il pannello viene mostrato per i job `running`, `completed` e `failed` allo stesso modo — così la vista di dettaglio di un job concluso mostra le stesse metriche congelate ai loro valori finali.

## Le schede ticket

L'**intestazione ticket** sta tra l'intestazione di stato e il log. È una scheda d'identità premium che mostra un chip per ogni spec toccata dal job — ricavati dal comando avviato, così riflette esattamente quali ticket riguardava questa esecuzione.

- **2–3 ticket** — mostrati come elenco di chip.
- **4 o più** — si comprimono in una modalità compatta `+ N more` con un chevron per espandere, così l'intestazione resta ordinata.

Cliccando su un chip si apre il dettaglio di quella spec **sopra la pagina del job** — non perdi il segno né cambi pagina. È un modo rapido per rileggere cosa un job dovrebbe consegnare mentre lo guardi lavorare. (Sugli schermi in formato tablet puoi persino trascinare di lato una modale ticket per confrontare due spec fianco a fianco.)

## Il log in streaming

Sotto i pannelli c'è il log completo dell'esecuzione, trasmesso in tempo reale tramite WebSocket:

- L'**auto-scroll** mantiene in vista l'output più recente (scorri verso l'alto e si mette in pausa così puoi leggere).
- La **ricerca** per saltare a una frase.
- **Copia** per prendere l'intero log.

Questa è la verità grezza di ciò che l'AI sta facendo — ogni chiamata a uno strumento, ogni modifica a un file, ogni test eseguito.

## Esecuzioni di loop: l'esploratore di passi

Quando il job è un'**esecuzione di loop** (vedi [Il Loop Builder](the-loop-builder)), il log piatto lascia il posto a un **esploratore di passi** che rispecchia la forma reale del loop:

- **La striscia di panoramica** in alto è la mappa live del loop — un chip per nodo (Passo AI, Shell, Decisore del loop…), nell'ordine in cui scorre il grafo. I chip si accendono man mano che l'esecuzione avanza: attenuati in attesa, pulsanti durante l'esecuzione, poi una spunta o una croce. Il chip di un Decisore mostra anche il verdetto con cui ha instradato — tornare indietro o proseguire — e un contatore di iterazioni (`Iterazione 3/10`) tiene il conto a destra. Clicca un chip qualsiasi per saltare dritto all'ultimo passo di quel nodo.
- **Una scatola richiudibile per passo.** Ogni passaggio su un nodo diventa una sezione a sé, con il numero del passo, il nome, un badge di iterazione, la durata una volta concluso — e il proprio pulsante di copia, per portarti via esattamente l'output di un passo. (La copia nella barra degli strumenti prende sempre il log intero.) Tutto ciò che viene stampato prima del primo passo — il banner di avvio, l'avviso del worktree — finisce in una sezione **Preparazione**.
- **La modalità segui** è attiva per default: il passo in esecuzione resta aperto e scorre da solo mentre i precedenti si ripiegano. Nel momento in cui scorri verso l'alto o apri un passo più vecchio, il seguito si mette in pausa per lasciarti leggere — una pillola flottante **Riprendi a seguire** ti riporta al live. **Espandi tutto / Comprimi tutto** vivono nella barra degli strumenti, e la ricerca cerca in tutti i passi contemporaneamente.
- **Anche i passi interrotti sono onesti.** Un passo che non è mai riuscito a riportare il suo esito — l'esecuzione è stata annullata o l'app si è chiusa a metà passo — viene marcato **Interrotto** con un bordo tratteggiato, invece di fingere di aver finito.

Tutto il resto di questa pagina funziona esattamente allo stesso modo per le esecuzioni di loop — le metriche live, le schede ticket, il composer. I job che non sono loop mantengono il classico log in streaming qui sopra.

## Parla con il job in esecuzione

Ogni job Claude gira di default come una **sessione live**, quindi un composer di chat sta in fondo a questa pagina — e alla modale del job in modalità missione. Usalo per fare una domanda all'agente in esecuzione («perché quel test è fallito?») o per orientarlo a metà esecuzione («salta il refactoring, concentrati sul fix»).

Alcune cose che vale la pena sapere:

- **I messaggi si accodano, non interrompono.** Invia mentre l'agente sta trasmettendo e il tuo messaggio aspetta il suo turno — viene eseguito come prompt successivo, e il job continua a seguire il suo piano. Un piccolo contatore mostra quanti messaggi sono in coda.
- **La riga dei totali è reale.** Il composer mostra un riepilogo live `N turni · $X`, sommato dall'uso reale di ogni turno completato — coerente con la promessa di questa pagina di non tirare mai a indovinare.
- **Due modi in cui una sessione finisce.** La maggior parte dei job **si conclude da sola**: nel momento in cui un turno termina senza messaggi in coda, la sessione si assesta e il job si completa — i tuoi messaggi sono guida opzionale, mai un obbligo. Un'azione discreta **Concludi ora** la chiude prima, con tutto ciò che è stato prodotto fin lì. I job **Freestyle** sono l'eccezione: restano in attesa tra un turno e l'altro finché non clicchi **Finalize** — è il loro design, una sessione botta e risposta che chiudi quando hai finito.
- **Nelle esecuzioni di loop i messaggi vanno al passo attivo.** Su un loop integrato o personalizzato, il tuo messaggio raggiunge il **passo AI in esecuzione in quel momento**. Tra un passo e l'altro (mentre il Loop Decider riflette, o gira un comando shell) il composer mostra un breve stato *«In attesa del prossimo passo…»* — il testo in bozza viene conservato, e l'invio si riattiva quando parte il prossimo passo AI. **Assesta questo passo** termina il passo corrente in anticipo e lascia che il loop avanzi con ciò che ha prodotto.
- **Solo Claude, per ora.** I job Codex e Gemini girano one-shot esattamente come prima — non compare alcun composer. (Gli operatori del server possono spegnere l'intera funzionalità con `SPECRAILS_INTERACTIVE_JOBS=false`.)

## Esportazione diagnostica

Se la [telemetria](../settings/customizing) era abilitata per il job, nell'intestazione compare un pulsante **Esporta diagnostica**. Scarica uno ZIP che contiene:

- `job-metadata.json` — comando, stato, profilo, plugin.
- `telemetry.ndjson` — segnali OTLP/JSON non compressi.
- `logs.txt` — il log completo in streaming.
- `summary.md` — i punti salienti in formato leggibile.
- `profile.json`, `plugins.json` — snapshot esatti di ciò che è stato eseguito (quando presenti).

Comodo per condividere un'esecuzione con un collega, o per inviare una segnalazione di bug precisa.

## Dove andare ora

- [Rail e job](rails-and-jobs) — avvio e accodamento.
- [Batch implement e multi-feature](batch-implement-and-multi-feature) — molte spec, ondate di dipendenze.
- [Tracciare i costi](../analytics/tracking-cost) — trasforma i costi per job in analytics di progetto.
