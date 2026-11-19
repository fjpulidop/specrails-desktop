# La vista Dettaglio job

Clicca su una qualsiasi scheda job nella pagina **Job** e arrivi qui: la cabina di pilotaggio di una singola esecuzione di rail. È costruita attorno a una promessa — **i numeri live che vedi sono reali, mai ipotesi.** Questa pagina ti accompagna tra le fasi, le metriche live, le schede spec — e il composer che ti permette di **parlare con il job in esecuzione**.

## Il layout

L’intestazione compatta mantiene stato, durata, fase, azioni e chip della pipeline. Subito sotto, **una sola riga di navigazione** raccoglie tutto ciò che puoi guardare:

- **Cause dell’errore**: presente per un’esecuzione fallita o annullata con diagnosi, e selezionata per prima. Anche una domanda in sospeso a cui si può rispondere la rende disponibile: fai clic sul pulsante della domanda nell’intestazione per arrivarci e rispondere, anche senza diagnosi.
- **Grafo di esecuzione** e **Dettaglio del log**: per le esecuzioni di loop, il grafo del workflow e il log passo per passo.
- **Log**: per i job semplici, il log in streaming.

Accanto alle schede compaiono solo i chip che l’esecuzione ha meritato: **Verifica** (con il numero di controlli, nel colore del suo stato) quando l’esecuzione ha registrato prove di verifica — fai clic per vedere i controlli e il loro output — e un pulsante **Dettagli** (icona a barre) quando ci sono valori reali da mostrare. Entrambi si aprono come popover, così il registro mantiene sempre tutta l’altezza. L’ultima sezione del registro scelta viene ricordata separatamente per la pagina e per la finestra della missione; la scheda selezionata si reimposta a ogni visita.

### Istruzioni di esecuzione

Finché un’esecuzione può ancora leggerle, un compositore di una riga è ancorato in fondo al registro: scrivi ciò che l’agente deve tenere presente e premi il pulsante di invio o **⌘↵** (**Ctrl+Invio**). **Invio** aggiunge una riga. La **ⓘ** spiega la regola: le istruzioni vengono applicate al prossimo turno compatibile dell’agente; non rispondono a domande né concedono approvazioni. Ciò che hai inviato compare come chip accanto al compositore — *1 in coda*, *2 applicate* — che elenca ogni messaggio e il suo stato. Quando l’esecuzione si conclude il compositore scompare; un’esecuzione passata che ha ricevuto istruzioni mantiene il chip, in sola lettura, accanto alle schede.

Nell’app desktop, un job aperto da una missione compare nella **sua finestra**, una finestra per job. Premi **Escape** o chiudi la finestra per tornare; la versione browser mostra lo stesso contenuto in una modale.

## Fasi della pipeline

Per i job `Implement`, l'esecuzione attraversa le fasi definite dallo slash command — per impostazione predefinita:

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

Quale agente gestisce ogni fase lo decide il **profilo agente** del progetto. Il trio di base (`sr-architect`, `sr-developer`, `sr-reviewer`) è sempre presente; le regole di routing in un profilo possono aggiungere agenti o cambiare quale di essi esegue una fase. La barra di avanzamento delle fasi compare solo quando il comando definisce effettivamente delle fasi — i job che bypassano la pipeline (come un loop Freestyle dalla galleria) non ne mostrano alcuna.

## Metriche live — oneste per scelta

L’intestazione compatta mostra stato, durata, attività, passaggi e azioni. I valori reali e le note di ripresa si aprono dal pulsante **Dettagli** accanto alle schede:

| Metrica | Quando vedi il valore reale |
|--------|------------------------------|
| **Durata** | **Live.** Un ticker da 1 secondo conta in avanti mentre il job è in esecuzione — è l'unico numero davvero live. |
| **Turni** | Derivati in modo incrementale dagli eventi assistant in streaming man mano che arrivano. |
| **Token** | Aggregati in modo incrementale dallo stesso stream (tollera gli eventi privi dei campi di utilizzo). |
| **Costo** | Mostrato come `—` finché il job non termina, poi rivelato come l'autorevole `total_cost_usd`. |

Il principio di progettazione: **nessun numero approssimato o stimato durante l'esecuzione.** La durata è reale perché è semplicemente un orologio. Turni e token vengono accumulati dall'attività realmente trasmessa in streaming. Il costo deliberatamente *non* viene stimato durante l'esecuzione — appare come in attesa e si risolve solo nel suo valore finale e autorevole quando il provider lo riporta all'uscita del job. Se un numero sembra in attesa, è intenzionale — ti viene mostrata la verità, non una proiezione.

L'etichetta e l'icona dell'intestazione corrispondono allo stato del job, e il pannello viene mostrato per i job `running`, `completed` e `failed` allo stesso modo — così la vista di dettaglio di un job concluso mostra le stesse metriche congelate ai loro valori finali.

## Le schede spec

L'**intestazione spec** sta tra l'intestazione di stato e il log. È una scheda d'identità premium che mostra un chip per ogni spec toccata dal job — ricavati dal comando avviato, così riflette esattamente quali spec riguardava questa esecuzione.

- **2–3 spec** — mostrate come elenco di chip.
- **4 o più** — si comprimono in una modalità compatta `+ N more` con un chevron per espandere, così l'intestazione resta ordinata.

Cliccando su un chip si apre il dettaglio di quella spec **sopra la pagina del job** — non perdi il segno né cambi pagina. È un modo rapido per rileggere cosa un job dovrebbe consegnare mentre lo guardi lavorare. (Sugli schermi in formato tablet puoi persino trascinare di lato una modale spec per confrontare due spec fianco a fianco.)

## Il log in streaming

Apri **Log** (job semplici) o **Dettaglio del log** (esecuzioni di loop) per il log in streaming, oppure scegli Story quando la narrazione è attiva. L’output arriva in tempo reale via WebSocket:

- L'**auto-scroll** mantiene in vista l'output più recente (scorri verso l'alto e si mette in pausa così puoi leggere).
- La **ricerca** per saltare a una frase.
- **Copia** per prendere l'intero log.

Questa è la verità grezza di ciò che l'AI sta facendo — ogni chiamata a uno strumento, ogni modifica a un file, ogni test eseguito.

## Esecuzioni di loop: il grafo e il log dei passi

Per un’**esecuzione di loop** (vedi [Il Loop Builder](the-loop-builder)), due schede mostrano le evidenze.

**Grafo di esecuzione** è il workflow così come è stato eseguito. È sempre espanso e segue il passo in esecuzione, o quello che è fallito:

- **Il percorso seguito è a tratto pieno.** I passi attraversati dall’esecuzione sono disegnati pieni; quelli mai raggiunti sono tratteggiati e attenuati. Attiva **Solo il percorso seguito** per nascondere il resto. Una legenda sta in linea.
- **Ispeziona un passo.** Seleziona un nodo per elencarne i tentativi con stato e durata. Fai clic su un tentativo per aprirne il log in Dettaglio del log. **Ripeti da qui** sta sulla riga di ogni tentativo concluso, così un’esecuzione collegata parte esattamente dal tentativo che hai scelto. Gli id tecnici sono in **Traccia**.

**Dettaglio del log** contiene la sequenza dei passi e il log, e si apre sul passo che è fallito:

- **La striscia dei passi** in alto elenca solo i passi raggiunti dall’esecuzione, in ordine, con un contatore di iterazioni (`Iterazione 3/10`) a destra. I chip sono attenuati in attesa, pulsano durante l’esecuzione, poi mostrano una spunta o una croce; il chip di un Decisore mostra anche il verdetto con cui ha instradato. Fai clic su un chip per saltare a quel passo.
- **Una scatola richiudibile per passo.** Ogni passaggio su un nodo diventa una sezione a sé, con il numero del passo, il nome, un badge di iterazione, la durata una volta concluso — e il proprio pulsante di copia, per portarti via esattamente l'output di un passo. (La copia nella barra degli strumenti prende sempre il log intero.) Tutto ciò che viene stampato prima del primo passo — il banner di avvio, l'avviso del worktree — finisce in una sezione **Preparazione**.
- **La modalità segui** è attiva per default: il passo in esecuzione resta aperto e scorre da solo mentre i precedenti si ripiegano. Nel momento in cui scorri verso l'alto o apri un passo più vecchio, il seguito si mette in pausa per lasciarti leggere — una pillola flottante **Riprendi a seguire** ti riporta al live. **Espandi tutto / Comprimi tutto** vivono nella barra degli strumenti, e la ricerca cerca in tutti i passi contemporaneamente.
- **Anche i passi interrotti sono onesti.** Un passo che non è mai riuscito a riportare il suo esito — l'esecuzione è stata annullata o l'app si è chiusa a metà passo — viene marcato **Interrotto** con un bordo tratteggiato, invece di fingere di aver finito.

Story, quando la narrazione è attiva, è disponibile dentro Dettaglio del log. L’esplorazione del grafo e lo scorrimento del log in pausa si conservano cambiando scheda.

## Parla con il job in esecuzione

Ogni job Claude gira di default come una **sessione live**, quindi un composer di chat sta in fondo a questa pagina — e alla modale del job in modalità missione. Usalo per fare una domanda all'agente in esecuzione («perché quel test è fallito?») o per orientarlo a metà esecuzione («salta il refactoring, concentrati sul fix»).

Alcune cose che vale la pena sapere:

- **I messaggi si accodano, non interrompono.** Invia mentre l'agente sta trasmettendo e il tuo messaggio aspetta il suo turno — viene eseguito come prompt successivo, e il job continua a seguire il suo piano. Un piccolo contatore mostra quanti messaggi sono in coda.
- **La riga dei totali è reale.** Il composer mostra un riepilogo live `N turni · $X`, sommato dall'uso reale di ogni turno completato — coerente con la promessa di questa pagina di non tirare mai a indovinare.
- **Due modi in cui una sessione finisce.** La maggior parte dei job **si conclude da sola**: nel momento in cui un turno termina senza messaggi in coda, la sessione si assesta e il job si completa — i tuoi messaggi sono guida opzionale, mai un obbligo. Un'azione discreta **Concludi ora** la chiude prima, con tutto ciò che è stato prodotto fin lì. I vecchi job **Freestyle** (di quando Freestyle non era ancora un loop della galleria) sono l'eccezione: restano in attesa tra un turno e l'altro finché non clicchi **Finalize** — è il loro design, una sessione botta e risposta che chiudi quando hai finito.
- **Nelle esecuzioni di loop i messaggi vanno al passo attivo.** Su un loop integrato o personalizzato, il tuo messaggio raggiunge il **passo AI in esecuzione in quel momento**. Tra un passo e l'altro (mentre il Loop Decider riflette, o gira un comando shell) il composer mostra un breve stato *«In attesa del prossimo passo…»* — il testo in bozza viene conservato, e l'invio si riattiva quando parte il prossimo passo AI. **Assesta questo passo** termina il passo corrente in anticipo e lascia che il loop avanzi con ciò che ha prodotto.

## Esportazione diagnostica

Se la [telemetria](../settings/pipeline-telemetry-and-diagnostics) era abilitata per il job, nell'intestazione compare un pulsante **Esporta diagnostica**. Scarica uno ZIP che contiene:

- `job-metadata.json` — comando, stato, profilo, plugin.
- `telemetry.ndjson` — segnali OTLP/JSON non compressi.
- `logs.txt` — il log completo in streaming.
- `summary.md` — i punti salienti in formato leggibile.
- `profile.json`, `plugins.json` — snapshot esatti di ciò che è stato eseguito (quando presenti).

Comodo per condividere un'esecuzione con un collega, o per inviare una segnalazione di bug precisa.

## Quando un'esecuzione fallisce

Per un job fallito o annullato con diagnosi, **Cause dell’errore** si apre con la **scheda di diagnosi**, che spiega la causa e, quando è noto, perché è successo. Quando il runtime ha registrato quale passo è fallito, la scheda lo dice: il passo, il tentativo, l’iterazione e l’ora. Le cause:

- **Test falliti**: i controlli continuano a fallire dopo i giri di correzioni.
- **Limite del provider** — è stato raggiunto il limite d'uso del provider di IA. La scheda indica l'azzeramento nella tua ora locale quando il provider ha comunicato l'ora esatta, altrimenti con le sue parole. Una run ancora in pausa al limite mostra la propria scheda: quando riprende da sola, **Riprendi ora** e **Continua ora con** un altro provider. Vedi [Limiti d'uso](1-rails-and-jobs.md#usage-limits).
- **Ambiente**: la macchina non riesce a eseguire i controlli (credenziali, uno strumento mancante, un comando di preparazione che fallisce). *Sistema l'ambiente* mostra esattamente cosa eseguire o cambiare.
- **Porta in uso**: il controllo o il server dell'esecuzione non è partito perché un altro processo occupava già la sua porta (`EADDRINUSE`). Non conta come test falliti. Ogni worktree di esecuzione riceve porte proprie tramite `PORT` e `SPECRAILS_RUN_PORT_RANGE_START`/`_END`; un progetto che legge `PORT` non va mai in conflitto. Ferma l'altro processo, o fai leggere `PORT` al progetto, poi **Esegui di nuovo**.
- **Bloccata**, **senza tempo**, **in silenzio** e **fermata all'improvviso** indicano il limite o il processo che ha fermato l'esecuzione.
- **Attività incomplete**: l'esecuzione ha fatto il lavoro ma ha lasciato attività approvate non spuntate, ad esempio una verifica visiva. La scheda le elenca. **Continua** mantiene il lavoro e riavvia lo sviluppatore con lo strumento browser e la regola di installare ciò che manca, per esattamente quelle attività; quando restano solo verifiche che deve fare una persona, **Continua alla revisione** la manda in revisione con esse come *verifiche a mano* nel pacchetto di revisione.
- **Specifica rifiutata**: OpenSpec ha rifiutato il piano o la specifica e la pianificazione non è riuscita a ripararlo. **Modifica la spec e rilancia**.
- **Causa sconosciuta**: i registri dell'esecuzione non indicano una causa e l'app non tira a indovinare. La scheda mostra invece per prima l'analisi IA, indicata come tale, oppure offre **Analizza con l'IA** come prima azione; la fine del log resta a un clic.

Sotto la diagnosi ci sono fino a tre rimedi in ordine, e solo quelli che qui possono funzionare, ciascuno con una riga sotto che dice cosa fa al tuo lavoro: **Continua**, **Continua alla revisione**, **Modifica la spec e rilancia** (gli addenda della spec portano la tua modifica nell'esecuzione successiva), **Sistema l'ambiente** e **Apri i log al punto di errore**. **Ricomincia da capo** aspetta nel menu **⋯**: avvia una nuova esecuzione dalla base e il lavoro di questo tentativo non viene ripreso (resta nel vecchio worktree). La stessa causa appare come una riga nella [posta in arrivo](../getting-started/the-dashboard-tour), e la scheda di esecuzione della missione mostra la stessa scheda.

Le esecuzioni di Implement controllano da sole l'interfaccia e il comportamento visivo: ogni esecuzione ha uno strumento browser headless (`$SPECRAILS_BROWSE`) che apre l'app sulla porta propria dell'esecuzione, o una pagina del repository, in formato desktop e telefono, e restituisce screenshot che l'agente legge. Un controllo che solo una persona può fare (gusto, un dispositivo reale, credenziali reali) viene pianificato come *controllo a mano*: l'esecuzione non fallisce mai per esso, e ti arriva nel pacchetto di revisione.

### Continuare un'esecuzione {#continue}

**Continua** è l'unico modo di andare avanti per un'esecuzione fallita o fermata. Mantiene tutto ciò che l'esecuzione ha fatto e prosegue nello stesso worktree: un'esecuzione in pausa riprende sul posto; una fallita o fermata prosegue come il suo *tentativo* successivo, dal passaggio fallito o da dove l'hai fermata. Dice anche all'agente cosa è andato storto: per attività incomplete, le attività esatte con lo strumento browser e la regola di installare ciò che manca; per un problema della macchina, cosa mancava e come installarlo; dopo un errore momentaneo del provider, niente (lo stesso passaggio viene semplicemente rieseguito).

Un'esecuzione che hai fermato lo dice (**Hai fermato questa esecuzione**) e offre lo stesso **Continua**, mai un rilancio da zero.

I tentativi dello stesso lavoro sono un'unità. La finestra dell'esecuzione mostra dove si trova questo, ad esempio *Tentativo 3 di 4 · continuato dal passaggio Sviluppatore del tentativo 2*; fai clic per vedere ogni tentativo, aprirne uno qualsiasi e cosa è cambiato tra loro (chi ha continuato, da quale passaggio, le istruzioni inviate). Posta in arrivo, live board, elenco dei job e **⌘K** mostrano solo l'ultimo tentativo, con il suo numero: un tentativo fallito precedente che un altro ha ripreso non conta più come qualcosa che ti aspetta.

Quando la causa è nota e altro lavoro può risolverla (attività incomplete, uno strumento mancante, un errore momentaneo del provider, un tentativo bloccato), Specrails continua **una volta** da solo e scrive *Specrails ha continuato automaticamente* nella cronologia dell'esecuzione. Mai per credenziali o segreti, rifiuti di policy, limiti di spesa, limiti di utilizzo, uno stop scelto da te o lo stesso errore due volte. Disattivalo in **Impostazioni → Agenti Specrails → Continua le esecuzioni fallite**.

Quando l'analisi IA qui sotto suggerisce un passo che è uno di questi rimedi, appare come un pulsante accanto al passo.

### Analisi IA {#ai-failure-analysis}

Sotto la scheda, un’**Analisi IA** legge il log e spiega perché l’esecuzione si è fermata: la causa, **Cosa fare** e le righe **Dal log** su cui si è basata, citate parola per parola. Gira sullo stesso provider e modello che hanno eseguito il job, quindi il tuo account può sempre eseguirla. Parte da sola, tranne quando la causa è stata il limite del provider; in quel caso premi **Analizza con l’IA**. L’analisi viene salvata con il job. Se il log cambia in seguito, lo segnala e offre **Analizza di nuovo**.

L’analisi è indicata come una lettura dell’IA e non sostituisce mai la scheda: la diagnosi, la sua causa e i suoi rimedi restano quelli registrati dall’app. Controlla le righe che cita prima di agire. Il suo costo rientra in **Supporto** in [Analytics](../insights/analytics-and-cost-tracking).

## Dove andare ora

- [Rail e job](rails-and-jobs) — avvio e accodamento.
- [Analytics e monitoraggio dei costi](../insights/analytics-and-cost-tracking) — trasforma i costi per job in analytics di progetto.

## Dopo il riavvio di un workflow

Dopo un arresto improvviso, riprendi il workflow salvato con la configurazione e i repository originali. Una scrittura interrotta richiede di selezionare il tentativo esatto dopo aver esaminato il diff del worktree. I passaggi completati vengono conservati. Una chiamata al provider la cui risposta è andata persa resta conteggiata come interrotta, con consumo sconosciuto; non viene mai presentata come gratuita. Se i dati salvati non consentono di dimostrare la consegna originale, il recupero mostra un errore e conserva il worktree.

Quando un passaggio decisionale si interrompe per una domanda, la ripresa riutilizza la decisione salvata e trasmette la risposta umana al passaggio successivo. Non richiama il modello per la stessa decisione. Un prompt in pausa può richiedere un altro turno del modello per applicare la risposta.

## Conservazione della cronologia

Le esecuzioni salvate sono conservate indefinitamente per impostazione predefinita. In **Esecuzioni salvate → Conservazione della cronologia**, un progetto può conservarle da 1 a 3650 giorni. Nulla viene eliminato in background: salva la regola, scegli **Anteprima pulizia** e controlla ogni esecuzione e il suo motivo prima di **Elimina cronologia scaduta**. Un’esecuzione resta protetta finché è attiva, attende una tua risposta o approvazione, ha una scrittura interrotta, una consegna aperta o un fork che ne dipende ancora. Viene rimossa solo la cronologia di esecuzione nello spazio Specrails del progetto; repository, worktree, log del job e costi restano. Un’esecuzione scaduta appare come **Scaduto** e non può più essere ripresa né forkata. Le versioni di Core ancora usate da un’esecuzione conservata non vengono mai rimosse.
