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
- **Analytics** — quanto ti sta costando l'uso dell'AI. La spesa suddivisa per giorno, per attività, per modello e per ticket — così niente sorprese.
- **Agenti** — i profili degli agenti del tuo progetto: quali agenti vengono eseguiti nella pipeline e quali modelli AI usano. *(Solo per i progetti basati su Claude.)*
- **Codice** — un browser di file in sola lettura con riepiloghi AI in linguaggio semplice, e dei chip che indicano quali file l'AI ha toccato. Ottimo per chi non è sviluppatore ma vuole seguire ciò che accade.
- **Integrazioni** — componenti aggiuntivi opzionali, come collegare le tue spec a una board **Jira** o abilitare strumenti extra per l'AI.
- **Impostazioni** — opzioni per progetto (telemetria, budget, configurazione dei provider e altro ancora).

> Alcune sezioni compaiono solo quando hanno senso per i provider che hai scelto — per esempio, **Agenti** è specifica di Claude. Se non vedi una sezione, semplicemente non si applica alla configurazione di questo progetto.

## La barra di stato

Una sottile striscia corre lungo il bordo inferiore della finestra. È piccola ma utile:

- **Indicatore di connessione** (a sinistra) — un pallino colorato e un'etichetta che mostrano che l'app è attiva: verde per *connesso*, ambra durante la *riconnessione*, blu durante la *sincronizzazione* subito dopo una riconnessione. Raramente ne avrai bisogno, ma è rassicurante quando serve.
- **Spesa totale** (a destra) — un totale aggiornato di quanto hai speso, così il costo è sempre a portata di sguardo.
- **Interruttore del terminale** (all'estrema destra) — apre il pannello del terminale integrato. Premi **Cmd+J** (macOS) o **Ctrl+J** (Windows/Linux) per aprirlo o chiuderlo in qualsiasi momento. È una shell completa, aperta direttamente nella cartella del tuo progetto.

## Qualche scorciatoia utile

- **Cmd/Ctrl+B** — fissa o comprimi le barre laterali.
- **Cmd/Ctrl+J** — apri o chiudi il pannello del terminale.
- **Cmd/Ctrl+K** — apri la ricerca.

## Dove andare adesso

Questo è il quadro generale. Da qui, la prima mossa naturale è **aggiungere una spec** e avviarla su un rail — guarda la pipeline scorrere dall'inizio alla fine, poi controlla le **Analytics** per vedere quanto è costata. Benvenuto a bordo.
