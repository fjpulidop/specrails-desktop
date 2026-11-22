# Il tour della dashboard

Con un progetto aggiunto, ora hai davanti la tua **dashboard del progetto** — il quartier generale per trasformare le spec in codice consegnato. Ecco come orientarti.

## Il quadro generale

La finestra è divisa in tre zone:

- **Barra laterale sinistra** — l'elenco dei tuoi progetti. Clicca su un progetto qualsiasi per passarci all'istante; tutto il resto della finestra si aggiorna di conseguenza. Anche il pulsante **Aggiungi progetto** si trova qui.
- **Area principale** — la dashboard del progetto attivo: le tue spec e la pipeline che le esegue.
- **Barra laterale destra** — la navigazione tra le sezioni del progetto corrente.

## La dashboard principale

È qui che avviene il lavoro. La dashboard mostra:

- **Le tue spec** — le spec che hai creato, organizzati per stato (da Backlog/Da fare fino a Completato). Puoi visualizzarle come elenco, come griglia o come schede tipo post-it, a seconda di cosa preferisci.
- **Un modo per aggiungere una spec** — avvia un nuovo intervento. Puoi scrivere una spec rapida direttamente, oppure aprire una chat guidata **Explore** che ti aiuta a darle forma attraverso la conversazione e redige la spec al posto tuo.
- **I rail** — sono le corsie in cui le spec vengono costruite. Trascina una spec su un rail e avviala per farla passare attraverso la pipeline Architect → Developer → Reviewer → Ship. Più rail possono essere eseguiti contemporaneamente, così puoi lavorare a più cose in parallelo.

Quando una spec è in esecuzione, ne vedrai l'avanzamento nella pipeline e i log in tempo reale — l'output istantaneo dell'AI mentre progetta, scrive il codice e revisiona la tua modifica.

## La barra laterale destra: le sezioni del progetto

La barra laterale destra è il tuo centralino per il progetto corrente. Passaci sopra il cursore per espanderla, oppure fissala aperta. Le sezioni che troverai:

- **Dashboard** — la board delle spec e i rail (dove ti trovavi poco fa).
- **Job** — ogni esecuzione della pipeline per questo progetto, passata e presente, con stato, durata e la possibilità di approfondire il dettaglio e i log di ciascuna esecuzione.
- **Integrazioni** — componenti aggiuntivi opzionali, come collegare le tue spec a una board **Jira** o abilitare strumenti extra per l'AI.
- **Impostazioni** — opzioni per progetto (telemetria, budget, configurazione dei provider e altro ancora).

## La barra di stato

Una sottile striscia corre lungo il bordo inferiore della finestra. È uguale in modalità Missione e Board, e resta discreta: quando non c'è niente da dire, uno spazio resta semplicemente vuoto.

- **Connessione** (a sinistra) — vuota finché va tutto bene. Mostra *Riconnessione…* (ambra) o *Offline* (rosso) solo quando l'app perde il suo server locale, e *Sincronizzazione…* per un momento dopo la riconnessione.
- **Aggiorna** (a destra) — compare quando una nuova versione è pronta e l'app è inattiva da circa mezzo minuto. Cliccaci per aprire la scheda di aggiornamento (vedi [Aggiornamenti](../settings/6-updates.md)).
- **Uso del piano** (a destra) — un solo indicatore per il provider più vicino al suo limite. Resta neutro fino all'80%, diventa ambra con il nome del provider dall'80% e rosso dal 90%, e mostra *limite · si azzera 15:00* quando il provider rifiuta le richieste. Passaci sopra o cliccaci per vedere le finestre di ogni provider e la spesa di oggi in questo progetto.
- **Risorse dell'app** (a destra) — un'icona e il numero di processi, solo mentre c'è lavoro in corso. Cliccaci per vedere CPU e memoria, l'andamento della memoria e la suddivisione per origine: missioni e chat, rail, loop e job, processi in background, terminali, CLI degli agenti, MCP e runner, Git e il server Specrails stesso. Espandi un'origine per vederne i processi. Sotto le origini, **Porte dei worktree di esecuzione** elenca le porte servite dal server di sviluppo o di test di ogni rail (rail, spec, progetto e processo) e avvisa quando un altro processo occupa le porte assegnate a una rail. Nell'app desktop qui trovi anche **Mantieni il computer attivo**; finché è attivo, un'icona a forma di tazza nella barra di stato lo segnala (cliccaci per consentire di nuovo la sospensione).
- **Interruttore del terminale** (all'estrema destra) — apre il pannello del terminale integrato. Premi **Cmd+J** (macOS) o **Ctrl+J** (Windows/Linux) per aprirlo o chiuderlo in qualsiasi momento. È una shell completa, aperta direttamente nella cartella del tuo progetto.

## Finestre proprie

Nell'app desktop alcune schermate si aprono come vere finestre invece che come pannelli dentro la finestra principale: **Impostazioni**, il dettaglio di un job aperto da una missione, e **Loops** e **Plugin** in modalità Missione. Puoi spostarle su un altro schermo e continuare a lavorare nella finestra principale. Ognuna usa i controlli di finestra del sistema; le Impostazioni e la finestra del job si chiudono anche con **Escape**. Le modifiche che fai lì, come il tema o la lingua, si applicano subito alla finestra principale. Nella versione browser queste schermate si aprono come pannelli.

## Notifiche di ciò che ti aspetta {#attention}

Specrails ti avvisa quando qualcosa ti aspetta: una domanda o la risposta di una missione, una revisione pronta da decidere, un'esecuzione fallita, bloccata o ferma, un limite di spesa e un job terminato. Il modo dipende da dove sei:

- **Fuori dall'app** — una notifica di sistema con il progetto e la causa. Nell'app desktop non si può cliccare, quindi al tuo ritorno un avviso riassume (**3 elementi in sospeso**) e apre l'elemento, o **Da gestire** se sono più di uno. Gli avvisi che arrivano mentre **Riprendi da dove avevi lasciato** o il tour della piattaforma sono aperti aspettano che tu li chiuda, e poi arrivano tutti insieme.
- **Altrove nell'app** — un piccolo avviso con **Apri**.
- **Lo stai già guardando** — niente. Una missione che stai seguendo non segnala le proprie risposte; un'esecuzione bloccata è l'eccezione e avvisa sempre.

Ogni nuovo stato di un elemento viene annunciato una sola volta; dopo un riavvio non viene annunciato di nuovo nulla di vecchio. Nella posta in arrivo, gli elementi che non hai ancora visto hanno un punto; **Segna come non letto** e **Segna come letto** lo cambiano. Nell'app desktop l'icona del Dock (il launcher su Linux) mostra quanti elementi non hai visto.

Scegli di cosa essere avvisato in **Impostazioni ▸ Notifiche**: disattiva tutto, scegli le categorie (domande e risposte, revisioni, errori, limiti di spesa, job completati), aggiungi un suono, nascondi il badge del Dock o disattiva un progetto. Anche la campanella accanto al nome di un progetto nella posta in arrivo (**Silenzia le notifiche di …**) lo silenzia, così come **Silenzia le notifiche di …** nel menu **Altre azioni** di una riga; i suoi elementi restano nella posta in arrivo.

Un elemento si legge allo stesso modo ovunque: la riga della posta in arrivo, la sua scheda sulla bacheca live e la sua notifica usano lo stesso titolo e le stesse parole per dire perché aspetta (per esempio **Budget giornaliero del progetto raggiunto** · **Lavoro in pausa** · **5,12 USD su 5,00 USD spesi**).

## La bacheca live {#live-board}

La **bacheca live** mostra in un unico posto ogni esecuzione di ogni progetto: rail, loop, sessioni Intent e job. Aprila da **Bacheca live** nella barra laterale sinistra, con **Cmd+Shift+B** (**Ctrl+Shift+B** su Windows e Linux) o con **Apri bacheca live** nella palette dei comandi. È anche un link (`?live=1`), quindi **Indietro** la chiude.

Scegli come leggerla con il selettore nell'intestazione (la scelta viene ricordata):

- **Per stato**: tre colonne. **Richiede attenzione** è esattamente ciò che elenca la posta in arrivo (revisioni pronte da decidere, domande, errori, esecuzioni bloccate, limiti di spesa, aggiornamenti Jira), dal più vecchio, e il suo numero è quello della posta in arrivo; ogni scheda mantiene la spia del suo stato, così una revisione e una domanda si distinguono facilmente. **Apri Da gestire** in cima alla colonna apre l'elenco completo. **In corso** contiene ciò che è in esecuzione, poi ciò che attende in coda, poi ciò che è in pausa (con la spia di pausa). **Completato oggi** contiene ciò che oggi è terminato, è stato unito o fermato, e si svuota a mezzanotte. Un'esecuzione sta sempre in una sola colonna.
- **Per missione**: una riga per missione con ogni esecuzione che ha avviato, il progetto, il motore, il numero di esecuzioni e la spesa di oggi. Le missioni che hanno bisogno di te vengono prima; le esecuzioni non avviate da una missione chiudono l'elenco in **Non da una missione**.

Ogni scheda mostra lo stato dell'esecuzione, il rail o il tipo (e il progetto quando la bacheca ne copre più d'uno), il titolo, cosa sta facendo ora, i passaggi quando ci sono, il motore, da quanto è in esecuzione o in attesa e il costo quando è noto. Una domanda mostra il suo testo una sola volta. Una consegna che andrebbe in conflitto mostra un chip breve (**2 conflitti**); passaci sopra con il puntatore o dagli il focus per leggere la frase completa. Il pulsante della scheda è la stessa azione del resto dell'app: **Rispondi**, **Apri revisione**, **Riprendi**, **Riprova**, **Aumenta limite** o **Apri**, che apre la missione che ha avviato l'esecuzione o l'esecuzione stessa. Filtra per progetto, per tipo (Rail, Loop, Intent, Job) o per motore; l'intestazione riassume quante hanno bisogno di te e quante sono in corso (i conteggi delle colonne che vedi) e quanto hai speso oggi.

Nell'app desktop la bacheca si apre sempre in una finestra tutta sua, per un secondo schermo: ogni modo di aprirla porta in primo piano quella finestra, e **Cmd+Shift+B** la mostra o la nasconde. I suoi pulsanti, **Apri Da gestire** compreso, agiscono nella finestra principale, che passa in primo piano.

## Qualche scorciatoia utile {#shortcuts}

- **Cmd/Ctrl+B** — fissa o comprimi la barra laterale sinistra; **Option+Cmd+B** (**Ctrl+Alt+B**) fa lo stesso con quella destra.
- **Cmd/Ctrl+J** — apri o chiudi il pannello del terminale.
- **Cmd/Ctrl+K** — la palette dei comandi: cerca missioni, progetti e job ed **esegui azioni**. Digita un verbo ("nuova", "avvia", "sposta", "cambia") o inizia con **>** per elencare le azioni: Nuova spec (anche in Esplora), Avvia o Sposta una spec, Apri la sua revisione, Consegna o metti in pausa un Intent, Nuova missione, Cambia tema, Passa tra modalità Missione e Board, Apri le impostazioni dell'app o del progetto su una sezione, Esegui un loop, mostra/nascondi le barre laterali, Torna indietro o avanti, Annulla l'ultima modifica ed Eliminati di recente. Le azioni che richiedono una scelta (un rail, uno stato, un tema, una sezione) aprono una seconda pagina; **Backspace** a ricerca vuota torna indietro. Ogni azione mostra la propria scorciatoia da tastiera, così la palette insegna i tasti. Offre solo ciò che funziona dove ti trovi e rispetta le stesse regole dei pulsanti (una spec che non può essere avviata non viene proposta). A ricerca vuota elenca le tue **Azioni recenti** e i **Luoghi recenti**.
- **Cmd+[ / Cmd+]** (**Alt+← / Alt+→** su Windows/Linux), i pulsanti **←  →** nella barra del titolo o i pulsanti indietro/avanti del mouse — tornano indietro o avanti tra i luoghi visitati: spec, missioni, job, progetti e pannelli a schermo intero. Clic destro (o pressione prolungata) su un pulsante mostra gli ultimi luoghi.
- **Cmd+Maiusc+I** (**Ctrl+Alt+I** su Windows e Linux) o il pulsante **Da gestire** nella barra del titolo — l'elenco **Da gestire**: tutto ciò che ti aspetta in tutti i progetti, in un'unica lista raggruppata per progetto. Raccoglie le revisioni pronte da decidere, le domande a cui un agente sta aspettando risposta, le esecuzioni fallite o bloccate, le esecuzioni in pausa per il budget giornaliero e gli aggiornamenti Jira che non si sono potuti sincronizzare. Ogni riga ha un pulsante per l'azione principale (**Apri revisione**, **Rispondi**, **Riprendi**, **Riprova**, **Aumenta limite**); il resto è nel suo menu **Altre azioni** (**⋯**): **Posticipa di 1 ora**, **Posticipa a domani**, **Fatto**, **Segna come letto** o **Segna come non letto** e **Silenzia le notifiche di …** per il progetto. Le frecce scorrono i pulsanti principali delle righe; **Tab** raggiunge **⋯**, le frecce si muovono dentro il menu ed **Esc** chiude solo il menu. Un elemento posticipato o fatto torna da solo se il suo stato cambia. Il pulsante mostra quanti elementi attendono; è lo stesso numero che mostrano la bacheca live e la palette dei comandi. Una notifica di limite del provider apre l'elenco. L'elenco è anche un link (`?inbox=1`) e un'azione della palette dei comandi. Elenca anche le milestone in pausa o in attesa a un checkpoint (**Riprendi** / **Continua**) e le schede di missione che aspettano la tua decisione: una proposta di avvio, un'offerta Intent o un'offerta di correggere la CI (**Apri missione**).
- **M** — con una scheda spec a fuoco nella bacheca, apre un selettore per spostarla in uno stato o in un rail, l'equivalente da tastiera del trascinamento. Funziona anche su una selezione multipla, e la palette lo offre come **Sposta la spec a fuoco…**.
- **?** — la guida rapida alle scorciatoie. Scrivi nel suo campo di ricerca per filtrare le scorciatoie e trovare pagine e sezioni di questa guida, che si aprono nella guida senza lasciare la schermata. Le piccole icone **ⓘ** e i link **Scopri di più** accanto a impostazioni, rail, Intent, slider del contesto e budget aprono la guida nella sezione corrispondente allo stesso modo.

## Dove andare adesso

Questo è il quadro generale. Da qui, la prima mossa naturale è **aggiungere una spec** e avviarla su un rail — guarda la pipeline scorrere dall'inizio alla fine, poi controlla le **Analytics** per vedere quanto è costata. Benvenuto a bordo.
