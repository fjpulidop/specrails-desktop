# Il tour della dashboard

Con un progetto aggiunto, ora hai davanti la tua **dashboard del progetto** — il quartier generale per trasformare le spec in codice consegnato. Ecco come orientarti.

## Il quadro generale

La finestra è divisa in tre zone:

- **Barra laterale sinistra** — l'elenco dei tuoi progetti. Clicca su un progetto qualsiasi per passarci all'istante; tutto il resto della finestra si aggiorna di conseguenza. Anche il pulsante **Aggiungi progetto** si trova qui.
- **Area principale** — la dashboard del progetto attivo: le tue spec e la pipeline che le esegue.
- **Barra laterale destra** — la navigazione tra le sezioni del progetto corrente.

## La dashboard principale

È qui che avviene il lavoro. La dashboard mostra:

- **Le tue spec** — i ticket che hai creato, organizzati per stato (da Backlog/Da fare fino a Completato). Puoi visualizzarle come elenco, come griglia o come schede tipo post-it, a seconda di cosa preferisci.
- **Un modo per aggiungere una spec** — avvia un nuovo intervento. Puoi scrivere una spec rapida direttamente, oppure aprire una chat guidata **Explore** che ti aiuta a darle forma attraverso la conversazione e redige il ticket al posto tuo.
- **I rail** — sono le corsie in cui le spec vengono costruite. Trascina una spec su un rail e avviala per farla passare attraverso la pipeline Architect → Developer → Reviewer → Ship. Più rail possono essere eseguiti contemporaneamente, così puoi lavorare a più cose in parallelo.

Quando una spec è in esecuzione, ne vedrai l'avanzamento nella pipeline e i log in tempo reale — l'output istantaneo dell'AI mentre progetta, scrive il codice e revisiona la tua modifica.

## La barra laterale destra: le sezioni del progetto

La barra laterale destra è il tuo centralino per il progetto corrente. Passaci sopra il cursore per espanderla, oppure fissala aperta. Le sezioni che troverai:

- **Dashboard** — la board delle spec e i rail (dove ti trovavi poco fa).
- **Job** — ogni esecuzione della pipeline per questo progetto, passata e presente, con stato, durata e la possibilità di approfondire il dettaglio e i log di ciascuna esecuzione.
- **Integrazioni** — componenti aggiuntivi opzionali, come collegare le tue spec a una board **Jira** o abilitare strumenti extra per l'AI.
- **Impostazioni** — opzioni per progetto (telemetria, budget, configurazione dei provider e altro ancora).

## La barra di stato

Una sottile striscia corre lungo il bordo inferiore della finestra. È piccola ma utile:

- **Indicatore di connessione** (a sinistra) — un pallino colorato e un'etichetta che mostrano che l'app è attiva: verde per *connesso*, ambra durante la *riconnessione*, blu durante la *sincronizzazione* subito dopo una riconnessione. Raramente ne avrai bisogno, ma è rassicurante quando serve.
- **Spesa totale** (a destra) — un totale aggiornato di quanto hai speso, così il costo è sempre a portata di sguardo.
- **Interruttore del terminale** (all'estrema destra) — apre il pannello del terminale integrato. Premi **Cmd+J** (macOS) o **Ctrl+J** (Windows/Linux) per aprirlo o chiuderlo in qualsiasi momento. È una shell completa, aperta direttamente nella cartella del tuo progetto.

## Qualche scorciatoia utile {#shortcuts}

- **Cmd/Ctrl+B** — fissa o comprimi la barra laterale sinistra; **Option+Cmd+B** (**Ctrl+Alt+B**) fa lo stesso con quella destra.
- **Cmd/Ctrl+J** — apri o chiudi il pannello del terminale.
- **Cmd/Ctrl+K** — la palette dei comandi: cerca missioni, progetti e job ed **esegui azioni**. Digita un verbo ("nuova", "avvia", "sposta", "cambia") o inizia con **>** per elencare le azioni: Nuova spec (anche in Esplora), Avvia o Sposta una spec, Apri la sua revisione, Consegna o metti in pausa un Flow, Nuova missione, Cambia tema, Passa tra modalità Missione e Board, Apri le impostazioni dell'app o del progetto su una sezione, Esegui un loop, mostra/nascondi le barre laterali, Torna indietro o avanti, Annulla l'ultima modifica ed Eliminati di recente. Le azioni che richiedono una scelta (un rail, uno stato, un tema, una sezione) aprono una seconda pagina; **Backspace** a ricerca vuota torna indietro. Ogni azione mostra la propria scorciatoia da tastiera, così la palette insegna i tasti. Offre solo ciò che funziona dove ti trovi e rispetta le stesse regole dei pulsanti (una spec che non può essere avviata non viene proposta). A ricerca vuota elenca le tue **Azioni recenti** e i **Luoghi recenti**.
- **Cmd+[ / Cmd+]** (**Alt+← / Alt+→** su Windows/Linux), i pulsanti **←  →** nella barra del titolo o i pulsanti indietro/avanti del mouse — tornano indietro o avanti tra i luoghi visitati: spec, missioni, job, progetti e pannelli a schermo intero. Clic destro (o pressione prolungata) su un pulsante mostra gli ultimi luoghi.
- **Cmd+Maiusc+I** (**Ctrl+Alt+I** su Windows e Linux) o il pulsante **Da gestire** nella barra del titolo — l'elenco **Da gestire**: tutto ciò che ti aspetta in tutti i progetti, in un'unica lista raggruppata per progetto. Raccoglie le revisioni pronte da decidere, le domande a cui un agente sta aspettando risposta, le esecuzioni fallite o bloccate, le esecuzioni in pausa per il budget giornaliero e gli aggiornamenti Jira che non si sono potuti sincronizzare. Ogni riga ha l'azione principale a portata di mano (**Apri revisione**, **Rispondi**, **Riprendi**, **Riprova**) più **Posticipa** (1 ora o fino a domani) e **Fatto**. Un elemento posticipato o fatto torna da solo se il suo stato cambia. Il pulsante mostra quanti elementi attendono e una notifica di limite del provider apre l'elenco. L'elenco è anche un link (`?inbox=1`) e un'azione della palette dei comandi.
- **M** — con una scheda spec a fuoco nella bacheca, apre un selettore per spostarla in uno stato o in un rail, l'equivalente da tastiera del trascinamento. Funziona anche su una selezione multipla, e la palette lo offre come **Sposta la spec a fuoco…**.
- **?** — la guida rapida alle scorciatoie. Scrivi nel suo campo di ricerca per filtrare le scorciatoie e trovare pagine e sezioni di questa guida, che si aprono nella guida senza lasciare la schermata. Le piccole icone **ⓘ** e i link **Scopri di più** accanto a impostazioni, rail, Flow, slider del contesto e budget aprono la guida nella sezione corrispondente allo stesso modo.

## Dove andare adesso

Questo è il quadro generale. Da qui, la prima mossa naturale è **aggiungere una spec** e avviarla su un rail — guarda la pipeline scorrere dall'inizio alla fine, poi controlla le **Analytics** per vedere quanto è costata. Benvenuto a bordo.
