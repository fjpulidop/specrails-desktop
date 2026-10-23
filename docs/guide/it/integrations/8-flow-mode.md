# Flow: prima costruisci, poi la spec

Flow è un modo per costruire con un agente quando non sai ancora esattamente cosa vuoi. Parli con l’agente nella tua missione, lui scrive ed esegue codice reale in un worktree isolato e, quando il risultato è quello giusto, dici **Ecco fatto**: un rail prende il worktree, deriva la spec ed esegue la consueta verifica, revisione e consegna.

Implement serve a delegare un lavoro che sai già descrivere. Flow serve a scoprirlo.

## Come inizia un Flow

Non devi chiedere Flow per nome. Quando descrivi qualcosa di esplorativo o visivo («voglio provare…», «non so come dovrebbe venire»), la missione mostra una scheda con due strade:

- **Flow** — costruirlo insieme adesso; la spec arriva alla fine.
- **Spec + Implement** — concordare prima una spec, poi delegarla a un rail.

Le due strade hanno lo stesso peso e compaiono sempre nello stesso ordine: nessuna è consigliata, scegli tu. Sotto **Perché l’agente lo chiede** l’agente spiega in una frase cosa lo ha spinto a chiedere, e non insiste qualunque strada tu scelga o se premi **Non ora**.

Scegliendo Flow si apre una conferma: Specrails crea un worktree isolato in cui l’agente può scrivere codice, e il tuo branch principale non viene toccato. Premi **Avvia Flow**. Sulla board compare una spec provvisoria con l’etichetta **In Flow** (cliccala per tornare alla missione).

Se il tuo Specrails Core non può ancora eseguire Flow, il pulsante è disattivato e la scheda elenca cosa manca; di solito basta aggiornare Specrails Core.

## Durante il Flow

La conversazione cambia aspetto (una sottile linea d’accento sul bordo) e sopra il compositore compare una barra:

- il **branch** del worktree, i **file modificati** con le righe aggiunte e rimosse e il **costo reale** del Flow finora, come fatturato dal provider. Mostra `—` finché un turno non ha un costo comunicato, mai una stima;
- fai clic sui **file modificati** per vedere ogni file con stato e +/−, e sul **branch** per copiarne il nome;
- **Pausa** ferma l’agente e conserva worktree e spec. La missione mostra poi **Riprendi Flow**;
- **Scarta**, separato a sinistra, elimina il worktree, il suo branch e la spec provvisoria. La conferma elenca cosa perdi: i file modificati con i loro +/−, il branch e la spec;
- **Ecco fatto** — l’azione principale, qui sotto. Quando non è disponibile (il Flow sta ancora salvando, è in corso un’altra azione), passandoci sopra dice perché.

Puoi scrivere mentre l’agente lavora: in Flow il tuo messaggio **interrompe** il passo in corso (il pulsante di invio diventa un fulmine) e l’agente prosegue subito con le nuove informazioni. Finché la barra è visibile, la striscia git sotto il compositore si fa da parte: la barra mostra già il branch del worktree.

## Prova l’app

L’agente Flow esegue da solo il typecheck e i test per verificare il proprio lavoro. Quando c’è qualcosa da provare, chiede con tre opzioni: **Start the app**, **Start and expose on the local network** o **Not now**. Esporla ti permette di aprire l’app da un telefono sulla stessa Wi-Fi o VPN, e chiunque su quella rete può raggiungerla.

Quando l’app è in ascolto, l’agente ti dà i suoi indirizzi come link e la barra di Flow mostra **Anteprima** con un punto verde: apre l’app nel browser. Il suo menu ha l’indirizzo di rete e **Arresta app**. L’app gira nel worktree del Flow, mai nel checkout principale, e Specrails la arresta quando metti in pausa, scarti o consegni il Flow.

## Ecco fatto

Quando il risultato ti convince, premi **Ecco fatto**. La barra di Flow e l’effetto visivo spariscono e compare la solita scheda di lancio del rail, con il loop **Flow → Spec** preselezionato e un rail libero già scelto. Regola motore, modello o sforzo se vuoi e premi **Lancia**. Se è stato raggiunto il limite di revisione o un budget, la scheda lo dice e non lancia. **Non ancora** ti riporta al Flow.

Il rail deriva la spec di Specrails e il change OpenSpec da ciò che hai costruito, li verifica e li revisiona, e la scheda di consegna compare nella missione come per qualsiasi esecuzione.

Sopra la scheda di avvio, un riepilogo di una riga mostra cosa va al rail (file e righe) e il costo del Flow finora. Se l’esecuzione fallisce per un motivo tecnico, il lavoro torna da solo a questo Flow, intatto: la scheda spiega in parole semplici cosa è fallito (i codici restano in **Dettagli tecnici**) e l’agente riceve l’errore e lo spiega. Se la revisione chiede modifiche, la scheda offre **Torna in Flow** o **Rilancia**. Quando la consegna si conclude, la missione chiude il Flow con un riepilogo: la pull request, la spec riscritta da ciò che hai costruito, la modifica OpenSpec archiviata e l’issue Jira se c’è.

## Buono a sapersi

- Flow scrive solo dentro il suo worktree. Fuori da Flow le missioni restano in sola lettura.
- Un solo Flow per missione alla volta. La pausa sopravvive al riavvio dell’app.
- Se il worktree scompare, il Flow viene segnato **da controllare** e non si cancella nulla.
- Jira non riceve nulla mentre sei in Flow o se lo scarti.
- Il costo di Flow compare in Analytics come superficie a sé, **Flow**, e nel blocco delle missioni agente.
