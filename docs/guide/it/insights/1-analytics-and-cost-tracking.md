# Analytics e monitoraggio dei costi

Ogni volta che Specrails esegue una CLI AI per tuo conto — un job della pipeline, una spec rapida, una sessione Explore, un raffinamento AI, un riepilogo di file — registra cosa è successo: quale modello è stato eseguito, quanti token sono entrati e usciti, quanto tempo è servito e quanto è costato. La sezione **Analytics** trasforma tutto questo in un'unica dashboard, così sai sempre dove sta andando la tua spesa AI.

Aprila dalla barra laterale destra (è etichettata **Analytics**). Tutto ciò che vedi è circoscritto al progetto in cui ti trovi: cambia progetto e i numeri lo seguono.

## Cosa conta come spesa

Conta ogni chiamata AI del progetto: i job della pipeline e i passi dei loop, la scrittura delle spec, i riepiloghi dei file, le chat laterali, la diagnosi dei fallimenti, e le missioni e i turni Intent che esegui con l'agente mentre è fissato a questo progetto. Le missioni nella Home (senza progetto fissato) non appartengono a nessun progetto e qui non vengono contate.

Ogni chiamata è etichettata con l'*origine* che l'ha generata, e ogni origine appartiene a una di cinque **categorie** che dicono *perché* sono stati spesi i soldi:

- **Implementazione** — costruire spec con rail, loop e job.
- **Missioni** — parlare con l'agente e modalità Intent (turni di missione, turni Intent e la riscrittura della spec di Intent).
- **Spec** — scrivere e rifinire spec: spec Quick ed Explore, raffinamento, suddivisione, l'avvio spec, le proposte e il triage.
- **Codice** — spiegare il codice: riepiloghi dei file e storie dei file.
- **Supporto** — configurazione, diagnosi e chat laterali: analisi dei fallimenti, configurazione, Agent Studio e la chat nella barra laterale.

## Leggere la dashboard

La pagina si legge dall'alto verso il basso come *quanto → in cosa e perché → quando → con quali modelli → le singole chiamate*.

### Quanto (Hero)

Il grande numero in cima è la tua spesa totale per il periodo selezionato, con un delta **vs prec.** che ti permette di capire al volo se la tendenza è in salita o in discesa rispetto alla finestra precedente. Quando ogni motore è su un piano in abbonamento, la cifra è indicata come *Stima equivalente in API*: quanto costerebbero le chiamate ai prezzi delle API, non denaro effettivamente addebitato. Se hai appena iniziato a usare un progetto, lo stato vuoto ti dice quando è cominciato il tracciamento.

### Dove sono finiti i soldi

Una riga per categoria con il suo costo, la sua quota del totale, il numero di chiamate e di token e un motivo in una riga. La parte tratteggiata di una barra è costo stimato (motori che non riportano il costo in modo nativo). Apri una categoria per vedere le origini che la compongono, e clicca su una per filtrare l'intera pagina su di essa. La categoria Missioni elenca anche le tue conversazioni più costose.

### Timeline giornaliera

Un grafico a barre impilate della spesa per giorno, suddivisa per origine, con le missioni nel loro colore. I giorni senza attività sono mostrati come zero anziché saltati. È il modo più rapido per vedere *quando* è stato eseguito un batch costoso.

### Budget

I tuoi limiti giornaliero, settimanale, mensile e per esecuzione, la proiezione a fine mese e il ricalcolo "e se" (vedi sotto).

### Motori e modelli

La spesa per motore (nei progetti con più di uno) e i tuoi modelli principali per spesa. Clicca un modello qualsiasi per filtrare l'intera dashboard solo su quel modello.

### Top spec

Le tue dieci spec più costose su *tutte* le origini messe insieme, così una spec che è costata poco in Explore e molto in un job mostra il suo totale reale. I turni di missione non hanno una spec, quindi qui non compaiono.

### Tabella delle invocazioni grezze

La verità di base: una riga per chiamata. La colonna **Motivo** mostra l'origine e la sua categoria; le righe di missione e Intent mostrano la conversazione a cui appartengono. Questo blocco ha i propri filtri secondari, che agiscono solo sulla tabella.

### Altre ripartizioni

Compresse per impostazione predefinita: tempo alla decisione e al merge, economia per loop, la dispersione costo vs turni e il confronto Quick vs Explore.

## Filtri

L'intestazione fissa porta i filtri principali — **periodo**, **categoria** e (nei progetti con più motori) **motore** — e tutti vengono salvati nell'URL della pagina, così puoi aggiungere ai segnalibri o condividere una vista filtrata ("ultimi 30 giorni, solo missioni"). Passa il cursore su un chip di categoria per vedere cosa comprende. Una singola origine si può selezionare dalla scheda *Dove sono finiti i soldi* (o con `?surface=` nell'URL); un chip rimovibile nell'intestazione la mostra. I filtri della tabella grezza sono separati e restano locali a quel blocco.

Una nota sull'accuratezza: le esecuzioni fallite e interrotte vengono tenute fuori dalle *medie di costo* (distorcerebbero i numeri per esecuzione), ma contano comunque nel conteggio totale delle esecuzioni e nel tasso di fallimento. Così le medie restano pulite e il quadro sull'affidabilità resta completo.

## Costo per spec

Non devi venire alla pagina Analytics per vedere quanto è costata una spec. Apri una spec qualsiasi e, se ha una spesa associata, vedrai un riepilogo su una riga proprio sotto il titolo:

> $0.42 · 6 turni · 1m 12s attivi · dettaglio

Cliccaci e atterri sulla pagina Analytics già filtrata su quella spec. È il percorso più rapido da "quanto mi è costata questa funzionalità?" al dettaglio completo.

## Tutti i progetti {#all-projects}

Per il quadro di tutti i progetti, apri **Analytics** dalla barra laterale sinistra o dalla palette dei comandi. Mostra costo totale, job e tasso di successo, il costo nel tempo e una riga per progetto, e usa le stesse cinque categorie e gli stessi colori della pagina del progetto. I turni di missione e Intent contano in ogni cifra. I turni che non appartengono a nessun progetto caricato, come le missioni nella Home e le chat di Blueprint o Builder, sono raggruppati in un'unica riga **Home e Blueprint**, contata in turni dell'agente invece che in job. Il costo stimato è indicato con `~`, come nella pagina del progetto.

## Esportare i tuoi dati

Quando ti servono i numeri fuori dall'app — un foglio di calcolo, un report finanziario, la tua analisi — usa il menu a tendina **Export**. Offre quattro formati:

- **CSV riepilogo** — un file multi-sezione con totali, timeline giornaliera, per categoria, per origine, per modello e top spec.
- **JSON riepilogo** — lo stesso riepilogo, strutturato.
- **CSV raw** — ogni riga di invocazione (fino a 10.000; segnala se ha dovuto troncare).
- **JSON raw** — le stesse righe grezze, strutturate.

Le esportazioni rispettano i filtri di periodo, categoria e origine che hai attualmente applicato, e i file vengono nominati in modo da ordinarsi in modo sensato: `<project>-analytics-<period>-<date>.csv`. Il pulsante è disabilitato quando non c'è nulla da esportare, e riceverai un chiaro toast di errore se un download fallisce.

## Sempre aggiornato

Non devi ricaricare. Quando una nuova invocazione viene registrata in qualsiasi punto del progetto, la dashboard aperta si aggiorna in silenzio un istante dopo, così il meter di consumo tiene il passo con il lavoro man mano che si completa.

## Budget giornalieri {#daily-budget}

Imposta un budget giornaliero per limitare quanto può costare una giornata. Tutti i limiti (giornaliero, settimanale, mensile e per esecuzione) si modificano in un unico posto: **Analisi → Budget**. **Impostazioni → Avanzate** e **Impostazioni del progetto → Budget** mostrano solo il limite giornaliero attuale, con un pulsante **Apri Budget** che porta lì.

Quando la spesa registrata della giornata raggiunge un budget, la coda si mette in pausa da sola, i rail e le esecuzioni dei loop non partono e mostrano *Budget giornaliero raggiunto*, e un’esecuzione di loop in corso si ferma tra un passo e l’altro, in pausa per il budget. Aumenta o rimuovi il budget, oppure attendi il reset giornaliero, poi riprendi. Un’esecuzione di loop bloccata solo dal budget giornaliero riprende da sola quando il giorno si azzera (a mezzanotte locale per il budget di un progetto, a mezzanotte UTC per quello dell’intera app), appena c’è capacità, e lo annota nel suo log; vale anche per un’esecuzione bloccata a cavallo della mezzanotte con l’app chiusa, che riprende all’avvio dell’app. Un’esecuzione che hai messo in pausa, o che il suo limite per esecuzione (o un limite settimanale o mensile) blocca ancora, continua ad aspettarti. Puoi disattivarlo in **Impostazioni → Avanzate → Riprendi le esecuzioni bloccate dal limite giornaliero quando il giorno si azzera**.

Entrambi i budget contano la tua giornata locale ed entrambi includono la spesa delle missioni: il budget di un progetto conta i turni fissati a quel progetto, quello dell’intera app conta ogni turno. "Oggi" indica la tua giornata locale ovunque nell’app, nella barra di stato, in Analytics e nei budget. L’avviso di costo per job è un’impostazione separata.

**Limiti settimanali, mensili e per esecuzione.** I limiti più lunghi funzionano allo stesso modo. Apri **Analisi → Budget** per impostare un limite **settimanale** e uno **mensile**, per progetto e per l’intera app, e un **limite morbido per esecuzione** (*metti in pausa e chiedi a $X*). Le settimane iniziano il lunedì e i mesi il giorno 1, nel tuo fuso orario locale. Un limite settimanale o mensile mette in pausa le code, rifiuta gli avvii e ferma i loop in corso esattamente come il budget giornaliero; aumentalo o rimuovilo lì, oppure aspetta il ripristino. Un passaggio già iniziato non si può fermare, quindi il limite per esecuzione si controlla **prima di ogni passaggio IA**, rispetto a quanto quel passaggio costa di solito: quanto è costato prima nella stessa esecuzione, altrimenti la mediana delle sue esecuzioni recenti nel progetto con lo stesso modello, altrimenti una stima di un passaggio tipico del suo genere dal listino prezzi. Quando il passaggio successivo non rientra, l’esecuzione si mette in pausa prima di esso e lo spiega (*In pausa prima di Developer: di solito costa circa $0.45 e restano $0.12 del limite di $0.40 per esecuzione*); **Riprendi** offre allora di **eseguire solo questo passaggio** (dopo il limite torna a valere), continuare senza il limite o aumentarlo. Un’esecuzione il cui costo riportato raggiunge il limite si mette in pausa allo stesso modo. Sono stime: un passaggio che costa molto più del solito può comunque superare il limite. Raggiungere un limite aggiunge anche un elemento **Aumenta limite** alla posta in arrivo.

Il pannello Budget mostra oggi, questa settimana e questo mese rispetto a ogni limite. La sua **proiezione** a fine mese è una stima (la media degli ultimi 14 giorni completi per i giorni rimasti, più quanto hai già speso) e non viene mai sommata alla spesa fatturata. **E se** ricalcola gli ultimi 30 giorni di uso di token registrato con un altro modello, usando il listino prezzi dell’app, e dice *Nessun prezzo* per un modello senza prezzo. Con un piano in abbonamento non c’è un costo in dollari per uso, quindi il pannello mostra turni e limiti del piano invece dei dollari.
