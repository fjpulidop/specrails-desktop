# Flow: prima costruisci, poi la spec

Flow è un modo per costruire con un agente quando non sai ancora esattamente cosa vuoi. Parli con l’agente nella tua missione, lui scrive ed esegue codice reale in un worktree isolato e, quando il risultato è quello giusto, dici **Ecco fatto**: un rail prende il worktree, deriva la spec ed esegue la consueta verifica, revisione e consegna.

Implement serve a delegare un lavoro che sai già descrivere. Flow serve a scoprirlo.

## Come inizia un Flow

Non devi chiedere Flow per nome. Quando descrivi qualcosa di esplorativo o visivo («voglio provare…», «non so come dovrebbe venire»), la missione mostra una scheda con due strade:

- **Flow** — costruirlo insieme adesso; la spec arriva alla fine.
- **Spec + Implement** — concordare prima una spec, poi delegarla a un rail.

La scheda indica la strada consigliata e spiega il perché in una frase. L’altra strada è sempre a un clic, e l’agente non insiste se la scegli o premi **Non ora**.

Scegliendo Flow si apre una conferma: Specrails crea un worktree isolato in cui l’agente può scrivere codice, e il tuo branch principale non viene toccato. Premi **Avvia Flow**. Sulla board compare una spec provvisoria con l’etichetta **In Flow** (cliccala per tornare alla missione).

Se il tuo Specrails Core non può ancora eseguire Flow, il pulsante è disattivato e la scheda elenca cosa manca; di solito basta aggiornare Specrails Core.

## Durante il Flow

La conversazione cambia aspetto (una sottile linea d’accento sul bordo) e sopra il compositore compare una barra:

- il **branch** del worktree, i **file modificati** con le righe aggiunte e rimosse e il **costo reale** del Flow finora, come fatturato dal provider. Mostra `—` finché un turno non ha un costo comunicato, mai una stima;
- **Vedi modifiche** elenca ogni file modificato con stato e +/−;
- **Pausa** ferma l’agente e conserva worktree e spec. La missione mostra poi **Riprendi Flow**;
- **Scarta** elimina, dopo una conferma, il worktree, il suo branch e la spec provvisoria;
- **Ecco fatto** — l’azione principale, qui sotto.

Puoi scrivere mentre l’agente lavora: in Flow il tuo messaggio **interrompe** il passo in corso (il pulsante di invio diventa un fulmine) e l’agente prosegue subito con le nuove informazioni. La striscia git sotto il compositore mostra il branch del worktree.

## Ecco fatto

Quando il risultato ti convince, premi **Ecco fatto**. La barra di Flow e l’effetto visivo spariscono e compare la solita scheda di lancio del rail, con il loop **Flow → Spec** preselezionato e un rail libero già scelto. Regola motore, modello o sforzo se vuoi e premi **Lancia**. Se è stato raggiunto il limite di revisione o un budget, la scheda lo dice e non lancia. **Non ancora** ti riporta al Flow.

Il rail deriva la spec di Specrails e il change OpenSpec da ciò che hai costruito, li verifica e li revisiona, e la scheda di consegna compare nella missione come per qualsiasi esecuzione.

## Buono a sapersi

- Flow scrive solo dentro il suo worktree. Fuori da Flow le missioni restano in sola lettura.
- Un solo Flow per missione alla volta. La pausa sopravvive al riavvio dell’app.
- Se il worktree scompare, il Flow viene segnato **da controllare** e non si cancella nulla.
- Jira non riceve nulla mentre sei in Flow o se lo scarti.
- Il costo di Flow compare in Analytics come superficie a sé, **Flow**, e nel blocco delle missioni agente.
