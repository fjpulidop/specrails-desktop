# Intent: di’ il problema, non la soluzione {#intent-mode}

Scrivere codice non è più la parte lenta del costruire software. Lo è sapere cosa costruire e verificare che sia stato costruito bene. Intent parte da qui. Scrivi l’**intent**: il problema, il risultato che vuoi, come saprai che ha funzionato, chi e cosa riguarda, i limiti e ciò che ancora nessuno sa. Non scrivi la soluzione. Specrails ricava la spec dal tuo intent e tu rivedi la spec invece di scriverla.

Da un intent ci sono due strade equivalenti:

- **Esplora**: costruiscilo insieme a un agente in una sessione Intent isolata (un branch tutto suo, una copia separata del tuo progetto). Quando il risultato è quello giusto, un rail ricava la spec da ciò che hai costruito.
- **Delega**: l’agente scrive la spec a partire dall’intent, tu la rivedi e un rail la costruisce.

Esplora serve a scoprire; Delega a costruire ciò che è già chiaro. Nessuna delle due è consigliata: scegli tu.

## L’intent

Un intent ha sei parti, e nessuna per la soluzione:

| Parte | Cosa contiene |
| --- | --- |
| **Problema** | Cosa non va oggi, per chi e quando fa male. |
| **Risultato cercato** | Cosa è vero quando il problema è risolto. Un’**ipotesi** facoltativa si legge *Crediamo che … produrrà …; lo sapremo quando …*. |
| **Come lo sapremo** | Segnali osservabili che il risultato c’è stato («un nuovo utente completa la configurazione in meno di 2 minuti»). Diventano criteri di accettazione. |
| **Chi e cosa riguarda** | Persone, schermate o sistemi. |
| **Vincoli** | Limiti che qualsiasi soluzione deve rispettare. |
| **Domande aperte** | Ciò che ancora nessuno sa. Gli agenti le indagano invece di tirare a indovinare. |

Se nomini una soluzione («aggiungere una cache Redis»), l’intent conserva a cosa serve («l’API risponde in meno di 200 ms») come risultato cercato, e la tua soluzione diventa un vincolo (la pretendi) o una domanda aperta (è un’opzione).

Ogni spec può avere un intent. Si trova sopra la descrizione nel dettaglio della spec, dove puoi modificare ogni parte. Le domande aperte con risposta mostrano la loro risposta. Una spec il cui intent ha ancora domande aperte mostra sulla board una piccola bussola con il loro numero. L’intent resta in Specrails, come **Fuori ambito**, e non viene mai scritto su Jira.

## Da dove viene un intent

- **In una missione (predefinito).** Quando descrivi un lavoro, l’agente ti intervista come un analista. Chiede degli utenti, dei limiti e di come saprai che ha funzionato, e mostra una scheda **Intent** con ogni parte e due letture della tua richiesta. Clicca su una lettura per rispondere, oppure rispondi con parole tue. Quando l’intent è definito, la scheda offre **Esplora** e **Delega** affiancati. Una spec che l’agente scrive a partire da esso porta l’intent automaticamente. Per saltare il passaggio dell’intent in una missione, invia `#noframe`; `#frame` lo riattiva.
- **In Aggiungi spec.** **Intent** è la prima modalità e si apre per impostazione predefinita. Descrivi il problema, non la soluzione, e premi **Genera intent e spec**. Un solo passaggio dell’AI scrive l’intent e poi la spec ricavata da esso, pronta da rivedere. Quick, Explore e Raw ci sono ancora. Se l’intent non si riesce a scrivere, ottieni comunque la spec, senza intent, e un avviso lo segnala.

## L’intent accompagna il lavoro

- Ogni agente che lavora sulla spec riceve prima l’intent, indicato come fonte di verità per il *perché* e per il *risultato cercato*, mai per il *come*. Vale per il pianificatore, lo sviluppatore, il revisore e l’agente della sessione Intent. Il revisore giudica il lavoro anche rispetto al risultato cercato e ai segnali.
- Quando un rail consegna una spec che ha un intent, Specrails lo scrive come `intent.md` nella modifica OpenSpec dell’esecuzione, accanto a proposta, design e task. L’intent vive così in Git insieme al codice. (Un’esecuzione in batch che copre più spec non ne scrive nessuno.)

## Esplora: avviare una sessione Intent

Scegli **Esplora** su una scheda di intent definito. Si apre una conferma: Specrails crea una copia separata del progetto su un branch dell’Intent tutto suo, dove l’agente può scrivere codice, e il tuo branch principale non viene toccato. Premi **Avvia Intent**. Sulla board compare una spec provvisoria con il tuo intent e l’etichetta **In Intent** (cliccala per tornare alla missione), e il primo turno dell’agente parte dall’intent.

## Avviare un Intent da una spec esistente

Qualsiasi spec si può costruire in Intent, non solo una nuova idea. Intent e Implement restano due modi equivalenti di lavorarci:

- nella board, fai clic destro su una spec e scegli **Avvia in Intent** (accanto al trascinarla su un rail); nel dettaglio della spec, **Avvia in Intent** è accanto a **Sposta su rail**;
- in una missione, quando chiedi di implementare una spec senza nominare un rail, l’agente mostra una scheda a due percorsi per quella spec: **Intent** ci lavora con te, **Spec + Implement** la avvia su un rail;
- una scheda di avvio su rail per una sola spec offre anche **Avvia in Intent** accanto al suo avvio.

La spec stessa diventa **In Intent**: non viene creata nessuna spec segnaposto e il primo turno dell’agente riceve la spec (prima il suo intent, poi i criteri di accettazione, Contract Layer, esclusioni e addenda aperti). Avviato dalla board, l’Intent si apre nella missione della spec oppure in una nuova missione con il nome della spec. In un progetto con più repository Git, quando la spec non ne indica esattamente uno, una piccola finestra chiede prima dove eseguire l’Intent: sono elencati solo i repository Git, è preselezionato il repository della spec (altrimenti il principale) e le frecce cambiano la scelta. **Avvia in Intent** è disattivato, con il motivo al passaggio del mouse, quando la spec è già in Intent, completata o annullata, si trova su un rail o Intent non è disponibile.

**Scarta** restituisce la spec esattamente com’era, con il suo stato precedente: la tua spec non viene mai eliminata. Alla consegna dell’Intent, la spec viene riscritta da ciò che è stato costruito e prima il suo testo originale resta come commento, **Original spec before Intent**, così non si perde nulla. L’intent in sé non viene mai riscritto: solo le sue domande aperte ricevono le risposte che il lavoro ha chiarito. Una spec già collegata a Jira aggiorna lo stesso issue e lo porta allo stato associato alla revisione; non viene creato un secondo issue.

## Durante l’Intent

La modalità Intent è nominata dove guardi, con il suo colore di Intent: il compositore mostra un chip **Intent** accanto a quello dell’autonomia e il suggerimento *Di’ all’agente cosa cambiare in questo Intent…*; il titolo della missione indica **In Intent**, così come la sua riga nell’elenco delle missioni. La conversazione segna dove sei entrato e uscito da Intent, e le risposte dell’agente scritte in Intent hanno un piccolo segno **Intent** accanto all’ora.

La striscia subito sopra il compositore mostra l’Intent in una riga breve: il suo stato, **Intent · 7 file**, **Sospendi Intent** e l’azione principale, **Affida**. Quando un’azione non è disponibile (l’Intent sta ancora salvando, è in corso un’altra azione), passandoci sopra si legge perché. Apri la riga con la sua freccia, come qualsiasi altra esecuzione, per vedere il resto:

- il **branch** (clic per copiarne il nome), le **modifiche** con le righe aggiunte e rimosse (clic per elencare ogni file modificato con il suo stato e i +/−) e il **costo finora** come fatturato dal provider. Mostra `—` finché un turno non ha un costo comunicato, mai una stima; un `*` segnala un totale che esclude turni senza prezzo, con una nota che dice quanti;
- **Anteprima** mentre l’app dell’Intent è in esecuzione (vedi sotto);
- **Scarta**, in disparte, elimina le modifiche dell’Intent, il suo branch e la spec provvisoria. La conferma elenca cosa perdi: i file modificati con i loro +/−, il branch e la spec.

**Sospendi Intent** ferma l’agente e conserva le tue modifiche e la spec. La riga mostra quindi **Riprendi Intent**.

Puoi scrivere mentre l’agente lavora: in Intent il tuo messaggio **interrompe** il passo in corso (il pulsante di invio diventa un fulmine) e l’agente prosegue subito con le nuove informazioni. Finché l’Intent è aperto, la striscia git sotto il compositore si fa da parte: il pannello dell’Intent mostra già il suo branch.

## Prova l’app

L’agente di Intent esegue da solo il typecheck e i test per controllare il suo lavoro. Quando c’è qualcosa da provare, chiede con tre scelte: **Start the app**, **Start and expose on the local network** o **Not now**. Esporla ti permette di aprire l’app da un telefono sulla stessa Wi-Fi o VPN, e chiunque su quella rete può raggiungerla.

Quando l’app è in ascolto, l’agente ti dà i suoi indirizzi come link e il pannello dell’Intent mostra **Anteprima** con un punto verde: apre l’app nel browser. Il suo menu ha l’indirizzo di rete e **Arresta app**. L’app gira dalla copia dell’Intent, mai dal tuo checkout principale, e Specrails la arresta quando metti in pausa, scarti o consegni l’Intent.

## Affida {#intent-hand-off}

Quando il risultato ti convince, premi **Affida**. La riga indica **Pronto a diventare una PR** e apre una sola riga sopra: *Rail 2 trasformerà i tuoi 7 file modificati in una PR revisionata. Se fallisce, il tuo lavoro è al sicuro.* Premi **Lancia**, oppure **Non ancora** per tornare all’Intent; **Esc** equivale a **Non ancora**; un clic altrove si limita a ripiegare la riga, che resta su **Pronto a diventare una PR** con **Lancia**. Se il motore della conversazione non può eseguire l’affidamento su questo computer, una nota subito sotto la riga lo dice e si usa il motore predefinito del rail.

Rail, motore, modello e sforzo sono già scelti per te (un rail libero e il motore della tua conversazione). Per cambiarli, apri **Cambia impostazioni**; lì vedi anche cosa è cambiato. Il costo finora è sulla riga principale. Le tue scelte restano se premi **Non ancora** e affidi di nuovo più tardi. Durante l’avvio la striscia mostra il lancio senza vuoti e poi segue l’esecuzione passo per passo. Se si raggiunge il limite di revisione o un budget, la riga lo dice e non parte nulla. Se l’esecuzione non compare entro 45 secondi, la striscia smette di girare e mostra **Affidamento a Rail 2 ancora in corso…** con **Aggiorna**, che ricontrolla e continua ad attendere finché l’esecuzione non compare.

Il rail ricava la spec e la sua modifica della spec da ciò che hai costruito, la verifica e la revisiona, e la scheda di consegna compare nella missione come per qualsiasi esecuzione.

Se l’esecuzione fallisce per un motivo tecnico, il lavoro torna da solo in questo Intent, intatto: la scheda dice con parole semplici cosa è fallito (i codici restano in **Dettagli tecnici**) e l’agente riceve l’errore e lo spiega. Se la revisione chiede modifiche, la scheda offre **Torna in Intent** o **Rilancia**. Quando la consegna si conclude, la missione chiude l’Intent con un riepilogo: la pull request, la spec riscritta da ciò che hai costruito, la modifica della spec archiviata e il ticket Jira, se c’è.

## Buono a sapersi

- Intent scrive solo sul suo branch. Fuori da Intent le missioni restano in sola lettura.
- Un Intent per missione alla volta. La pausa sopravvive al riavvio dell’app.
- Se la copia del progetto dell’Intent scompare, l’Intent viene segnato come **va controllato** (per informazione, niente da decidere) e non si cancella nulla.
- La striscia non cambia mai l’esecuzione che stai guardando. Se un’altra inizia ad aver bisogno di te nel frattempo, il suo nome nel selettore della striscia dice **ti aspetta**.
- Jira non riceve nulla mentre sei in Intent né se lo scarti.
- Il costo di Intent compare in Analisi come superficie a sé, **Intent**, e nel blocco delle missioni dell’agente.
