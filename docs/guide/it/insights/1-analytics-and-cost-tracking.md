# Analytics e monitoraggio dei costi

Ogni volta che Specrails esegue una CLI AI per tuo conto — un job della pipeline, una spec rapida, una sessione Explore, un raffinamento AI, un riepilogo di file — registra cosa è successo: quale modello è stato eseguito, quanti token sono entrati e usciti, quanto tempo è servito e quanto è costato. La sezione **Analytics** trasforma tutto questo in un'unica dashboard, così sai sempre dove sta andando la tua spesa AI.

Aprila dalla barra laterale destra (è etichettata **Analytics**). Tutto ciò che vedi è circoscritto al progetto in cui ti trovi: cambia progetto e i numeri lo seguono.

## Cosa conta come spesa

Specrails etichetta ogni esecuzione AI con un'*origine*: la parte dell'app che ha generato la spesa. Le origini principali hanno ciascuna un colore fisso e un proprio chip di filtro, così le riconosci a colpo d'occhio:

- **Job** — un job della pipeline messo in coda (Architect → Developer → Reviewer → Ship), comprese le esecuzioni Freestyle.
- **Loop** — ogni passo AI di un'esecuzione di loop. I rail girano come loop per impostazione predefinita, quindi gran parte della spesa dei rail finisce qui.
- **Quick** — una spec generata tramite il percorso rapido di Add Spec.
- **Explore** — una conversazione Explore in cui dai forma a una spec chiacchierando.
- **Raffinamento** — un raffinamento assistito dall'AI su un agente o su un file.
- **SMASH** — la suddivisione di una spec epica in spec più piccole.
- **Riepiloghi file** — i riepiloghi in linguaggio semplice e le storie dei file che alimentano il Code explorer.

Vengono tracciate anche origini minori, senza un chip proprio: la chat nella barra laterale, il launcher di spec OpenSpec, le proposte di spec, Agent Studio e la vecchia chat di setup. Anche le missioni fissate al progetto contano nella sua spesa. Nulla di ciò che esegue una CLI AI viene escluso, quindi i totali riflettono tutta l'attività AI del progetto.

## Leggere la dashboard

La pagina è composta da una manciata di blocchi, dall'alto verso il basso:

### Il meter di consumo (Hero)

Il grande numero in cima è la tua spesa totale per il periodo selezionato, con un delta **vs prec.** che ti permette di capire al volo se la tendenza è in salita o in discesa rispetto alla finestra precedente. Se hai appena iniziato a usare un progetto, lo stato vuoto ti dice quando è cominciato il tracciamento ("Tracciamento iniziato il YYYY-MM-DD") — non c'è alcun recupero dei dati storici, quindi il meter conosce solo le esecuzioni avvenute mentre eri su questa versione.

### Timeline giornaliera

Un grafico a barre impilate della spesa per giorno, suddivisa per origine. I giorni senza attività sono mostrati come zero anziché saltati, così la forma della tua settimana resta onesta. È il modo più rapido per vedere *quando* è stato eseguito un batch costoso.

### Quick vs Explore

Una scheda affiancata che confronta i tuoi due stili di creazione delle spec. Se hai eseguito meno di cinque sessioni Explore, mostra un gentile invito all'azione invece di medie fuorvianti — i campioni piccoli non danno confronti affidabili.

### Per modello

I tuoi modelli più costosi per spesa (fino a dieci). Clicca un modello qualsiasi per filtrare l'intera dashboard solo su quel modello — comodo quando vuoi sapere quanto ti sta costando davvero un particolare modello di fascia alta.

### Dispersione Costo vs Turni

Ogni punto è un'invocazione, che mette in relazione il costo con il numero di turni. I valori anomali — le esecuzioni costose e con molti turni — saltano subito all'occhio. (La dispersione mostra i tuoi 500 punti più recenti per restare reattiva.)

### Top ticket

I dieci ticket più costosi su *tutte* le origini messe insieme, così un ticket che è costato poco in Explore e molto in un job mostra il suo totale reale. I ticket eliminati e le esecuzioni non attribuite hanno i loro contenitori dedicati, così nulla scompare silenziosamente dai totali.

### Tabella delle invocazioni grezze

La verità di base: una riga per invocazione. Questo blocco ha i propri filtri secondari, che agiscono solo sulla tabella, così puoi approfondire senza disturbare i grafici sopra.

## Filtri

L'intestazione fissa in cima porta i due filtri principali — **periodo** e **origine** — ed entrambi vengono salvati nell'URL della pagina. Questo significa che puoi aggiungere ai segnalibri o condividere una vista filtrata ("ultimi 30 giorni, solo job") e si riaprirà esattamente come l'avevi lasciata. I filtri della tabella grezza sono separati e restano locali a quel blocco.

Una nota sull'accuratezza: le esecuzioni fallite e interrotte vengono tenute fuori dalle *medie di costo* (distorcerebbero i numeri per esecuzione), ma contano comunque nel conteggio totale delle esecuzioni e nel tasso di fallimento. Così le medie restano pulite e il quadro sull'affidabilità resta completo.

## Costo per ticket

Non devi venire alla pagina Analytics per vedere quanto è costata una spec. Apri un ticket qualsiasi e, se ha una spesa associata, vedrai un riepilogo su una riga proprio sotto il titolo:

> $0.42 · 6 turni · 1m 12s attivi · dettaglio

Cliccaci e atterri sulla pagina Analytics già filtrata su quel ticket. È il percorso più rapido da "quanto mi è costata questa funzionalità?" al dettaglio completo.

## Esportare i tuoi dati

Quando ti servono i numeri fuori dall'app — un foglio di calcolo, un report finanziario, la tua analisi — usa il menu a tendina **Export**. Offre quattro formati:

- **CSV riepilogo** — un file multi-sezione con totali, timeline giornaliera, per origine, per modello e top ticket.
- **JSON riepilogo** — lo stesso riepilogo, strutturato.
- **CSV raw** — ogni riga di invocazione (fino a 10.000; segnala se ha dovuto troncare).
- **JSON raw** — le stesse righe grezze, strutturate.

Le esportazioni rispettano i filtri di periodo e origine che hai attualmente applicato, e i file vengono nominati in modo da ordinarsi in modo sensato: `<project>-analytics-<period>-<date>.csv`. Il pulsante è disabilitato quando non c'è nulla da esportare, e riceverai un chiaro toast di errore se un download fallisce.

## Sempre aggiornato

Non devi ricaricare. Quando una nuova invocazione viene registrata in qualsiasi punto del progetto, la dashboard aperta si aggiorna in silenzio un istante dopo, così il meter di consumo tiene il passo con il lavoro man mano che si completa.

## Budget giornalieri {#daily-budget}

Imposta un budget giornaliero per limitare quanto può costare una giornata. Il budget dell’intera app si trova in **Impostazioni → Avanzate**; quello di un progetto in **Impostazioni del progetto → Budget**.

Quando la spesa registrata della giornata raggiunge un budget, la coda si mette in pausa da sola, i rail e le esecuzioni dei loop non partono e mostrano *Budget giornaliero raggiunto*, e un’esecuzione di loop in corso si ferma tra un passo e l’altro, in pausa per il budget. Aumenta o rimuovi il budget, oppure attendi il reset giornaliero, poi riprendi.

Il budget del progetto conta la tua giornata locale; quello dell’intera app conta la giornata UTC. L’avviso di costo per job è un’impostazione separata.
