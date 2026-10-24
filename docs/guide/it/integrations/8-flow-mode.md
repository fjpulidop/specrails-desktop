# Flow: prima costruisci, poi la spec

Flow è un modo di costruire con un agente quando non sai ancora esattamente cosa vuoi. Parli con l’agente nella tua missione, lui scrive ed esegue codice reale sul suo branch del Flow (una copia separata del tuo progetto) e, quando il risultato è quello giusto, premi **Affida**: un rail prende le tue modifiche, ricava la spec ed esegue la verifica, la revisione e la consegna di sempre.

Implement serve a delegare un lavoro che sai già descrivere. Flow serve a scoprirlo.

## Come inizia un Flow

Non devi mai chiedere Flow per nome. Quando descrivi qualcosa di esplorativo o visivo («voglio provare…», «non so come dovrebbe apparire»), la missione mostra una scheda con due strade:

- **Flow**: costruirlo insieme ora; la spec arriva alla fine.
- **Spec + Implement**: concordare prima una spec, poi delegarla a un rail.

Le due strade hanno lo stesso peso e compaiono sempre nello stesso ordine: nessuna è consigliata, scegli tu. In **Perché l’agente lo chiede** l’agente spiega in una frase cosa lo ha spinto a chiedere, e non insisterà qualunque strada tu scelga o se premi **Non ora**.

Scegliendo Flow si apre una conferma: Specrails crea una copia separata del progetto su un branch del Flow tutto suo, dove l’agente può scrivere codice, e il tuo branch principale non viene toccato. Premi **Avvia Flow**. Sulla board compare una spec provvisoria con l’etichetta **In Flow** (cliccala per tornare alla missione).

Se il tuo Specrails Core non può ancora eseguire Flow, Avvia è disattivato e la scheda elenca cosa manca. Di solito basta aggiornare Specrails Core.

## Avviare un Flow da una spec esistente

Qualsiasi spec si può costruire in Flow, non solo una nuova idea. Flow e Implement restano due modi equivalenti di lavorarci:

- nella board, fai clic destro su una spec e scegli **Avvia in Flow** (accanto al trascinarla su un rail); nel dettaglio della spec, **Avvia in Flow** è accanto a **Sposta su rail**;
- in una missione, quando chiedi di implementare una spec senza nominare un rail, l’agente mostra la stessa scheda a due percorsi per quella spec: **Flow** ci lavora con te, **Spec + Implement** la avvia su un rail;
- una scheda di avvio su rail per una sola spec offre anche **Avvia in Flow** accanto al suo avvio.

La spec stessa diventa **In Flow**: non viene creata nessuna spec segnaposto e il primo turno dell’agente riceve la spec (criteri di accettazione, Contract Layer, esclusioni e addenda aperti). Avviato dalla board, il Flow si apre nella missione della spec oppure in una nuova missione con il nome della spec. In un progetto con più repository Git, quando la spec non ne indica esattamente uno, una piccola finestra chiede prima dove eseguire il Flow: sono elencati solo i repository Git, è preselezionato il repository della spec (altrimenti il principale) e le frecce cambiano la scelta. **Avvia in Flow** è disattivato, con il motivo al passaggio del mouse, quando la spec è già in Flow, completata o annullata, si trova su un rail o Flow non è disponibile.

**Scarta** restituisce la spec esattamente com’era, con il suo stato precedente: la tua spec non viene mai eliminata. Alla consegna del Flow, la spec viene riscritta da ciò che è stato costruito e prima il suo testo originale resta come commento, **Original spec before Flow**, così non si perde nulla. Una spec già collegata a Jira aggiorna lo stesso issue e lo porta allo stato associato alla revisione; non viene creato un secondo issue.

## Durante il Flow

La modalità Flow è nominata dove guardi, con il suo colore di Flow: il compositore mostra un chip **Flow** accanto a quello dell’autonomia e il suggerimento *Di’ all’agente cosa cambiare in questo Flow…*; il titolo della missione indica **In Flow**, così come la sua riga nell’elenco delle missioni. La conversazione segna dove sei entrato e uscito da Flow, e le risposte dell’agente scritte in Flow hanno un piccolo segno **Flow** accanto all’ora.

La striscia subito sopra il compositore mostra il Flow in una riga breve: il suo stato, **Flow · 7 file**, **Sospendi Flow** e l’azione principale, **Affida**. Quando un’azione non è disponibile (il Flow sta ancora salvando, è in corso un’altra azione), passandoci sopra si legge perché. Apri la riga con la sua freccia, come qualsiasi altra esecuzione, per vedere il resto:

- il **branch** (clic per copiarne il nome), le **modifiche** con le righe aggiunte e rimosse (clic per elencare ogni file modificato con il suo stato e i +/−) e il **costo finora** come fatturato dal provider. Mostra `—` finché un turno non ha un costo comunicato, mai una stima; un `*` segnala un totale che esclude turni senza prezzo, con una nota che dice quanti;
- **Anteprima** mentre l’app del Flow è in esecuzione (vedi sotto);
- **Scarta**, in disparte, elimina le modifiche del Flow, il suo branch e la spec provvisoria. La conferma elenca cosa perdi: i file modificati con i loro +/−, il branch e la spec.

**Sospendi Flow** ferma l’agente e conserva le tue modifiche e la spec. La riga mostra quindi **Riprendi Flow**.

Puoi scrivere mentre l’agente lavora: in Flow il tuo messaggio **interrompe** il passo in corso (il pulsante di invio diventa un fulmine) e l’agente prosegue subito con le nuove informazioni. Finché il Flow è aperto, la striscia git sotto il compositore si fa da parte: il pannello del Flow mostra già il suo branch.

## Prova l’app

L’agente di Flow esegue da solo il typecheck e i test per controllare il suo lavoro. Quando c’è qualcosa da provare, chiede con tre scelte: **Start the app**, **Start and expose on the local network** o **Not now**. Esporla ti permette di aprire l’app da un telefono sulla stessa Wi-Fi o VPN, e chiunque su quella rete può raggiungerla.

Quando l’app è in ascolto, l’agente ti dà i suoi indirizzi come link e il pannello del Flow mostra **Anteprima** con un punto verde: apre l’app nel browser. Il suo menu ha l’indirizzo di rete e **Arresta app**. L’app gira dalla copia del Flow, mai dal tuo checkout principale, e Specrails la arresta quando metti in pausa, scarti o consegni il Flow.

## Affida

Quando il risultato ti convince, premi **Affida**. La riga indica **Pronto a diventare una PR** e apre una sola riga sopra: *Rail 2 trasformerà i tuoi 7 file modificati in una PR revisionata. Se fallisce, il tuo lavoro è al sicuro.* Premi **Lancia**, oppure **Non ancora** per tornare al Flow; **Esc** equivale a **Non ancora**; un clic altrove si limita a ripiegare la riga, che resta su **Pronto a diventare una PR** con **Lancia**. Se il motore della conversazione non può eseguire l’affidamento su questo computer, una nota subito sotto la riga lo dice e si usa il motore predefinito del rail.

Rail, motore, modello e sforzo sono già scelti per te (un rail libero e il motore della tua conversazione). Per cambiarli, apri **Cambia impostazioni**; lì vedi anche cosa è cambiato. Il costo finora è sulla riga principale. Le tue scelte restano se premi **Non ancora** e affidi di nuovo più tardi. Durante l’avvio la striscia mostra il lancio senza vuoti e poi segue l’esecuzione passo per passo. Se si raggiunge il limite di revisione o un budget, la riga lo dice e non parte nulla. Se l’esecuzione non compare entro 45 secondi, la striscia smette di girare e mostra **Affidamento a Rail 2 ancora in corso…** con **Aggiorna**, che ricontrolla e continua ad attendere finché l’esecuzione non compare.

Il rail ricava la spec e la sua modifica della spec da ciò che hai costruito, la verifica e la revisiona, e la scheda di consegna compare nella missione come per qualsiasi esecuzione.

Se l’esecuzione fallisce per un motivo tecnico, il lavoro torna da solo in questo Flow, intatto: la scheda dice con parole semplici cosa è fallito (i codici restano in **Dettagli tecnici**) e l’agente riceve l’errore e lo spiega. Se la revisione chiede modifiche, la scheda offre **Torna in Flow** o **Rilancia**. Quando la consegna si conclude, la missione chiude il Flow con un riepilogo: la pull request, la spec riscritta da ciò che hai costruito, la modifica della spec archiviata e il ticket Jira, se c’è.

## Buono a sapersi

- Flow scrive solo sul suo branch. Fuori da Flow le missioni restano in sola lettura.
- Un Flow per missione alla volta. La pausa sopravvive al riavvio dell’app.
- Se la copia del progetto del Flow scompare, il Flow viene segnato come **va controllato** (per informazione, niente da decidere) e non si cancella nulla.
- La striscia non cambia mai l’esecuzione che stai guardando. Se un’altra inizia ad aver bisogno di te nel frattempo, il suo nome nel selettore della striscia dice **ti aspetta**.
- Jira non riceve nulla mentre sei in Flow né se lo scarti.
- Il costo di Flow compare in Analisi come superficie a sé, **Flow**, e nel blocco delle missioni dell’agente.
