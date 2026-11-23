<!-- guide-revision: mission-first-v1 -->

# Rivedi una consegna nell'app {#review-a-delivery}

Una consegna pronta per la revisione ha due viste: **Panoramica** (il verdetto, le prove e i pulsanti di decisione) e **Modifiche** (ciò che la consegna ha davvero cambiato). Apri la revisione dal pulsante **Rivedi** della consegna e scegli **Modifiche**.

## Leggi le modifiche

L'elenco dei file a sinistra mostra ogni file modificato con il suo stato (aggiunto, modificato, eliminato, rinominato), i conteggi di righe `+` e `−` e un segno quando lo contrassegni come visto. Il diff a destra carica un file alla volta, quindi anche una modifica grande resta fluida. Passa tra i layout **Unificato** e **Affiancato**; Specrails ricorda la tua scelta. Un file molto grande mostra le prime righe con **Carica il diff completo del file**; un file binario è indicato come binario.

Le modifiche sono misurate dal punto in cui la consegna si è staccata dal branch di base, quindi ciò che è arrivato sulla base dopo non compare. Se la consegna non ha ancora un branch combinato, puoi scegliere il branch di quale spec leggere.

## Note del revisore sul codice

I rilievi del revisore, i rischi segnalati e i commenti di revisione che l'esecuzione doveva risolvere compaiono sotto la riga a cui si riferiscono. Le note che non indicano file né riga sono elencate sopra l'elenco dei file, quindi nulla resta nascosto. Le consegne più vecchie, e i revisori che non hanno indicato un punto, mostrano i rilievi in quell'elenco.

## Chiedi all'agente di cambiare qualcosa

Seleziona le righe cliccando sui loro numeri (Maiusc-clic estende l'intervallo), scegli **Chiedi una modifica all'agente** e descrivi la modifica. Specrails la salva come feedback di revisione sulla spec, con il file, l'intervallo di righe e il codice selezionato, e mostra un messaggio con un link alla spec. La prossima esecuzione su quella spec lo riceverà. Per avviarla subito usa **Chiedi modifiche** nella Panoramica. Qui non ci sono thread di commenti tra persone; confrontati con il tuo team su GitHub.

## Aprilo nel tuo editor

**Apri nell'editor** apre il file, alla riga selezionata, in VS Code, Cursor o in un IDE JetBrains. Scegli l'editor in **Impostazioni → Codice → Editor**. Il file si apre dalla tua copia del progetto, dove il branch della revisione potrebbe non essere attivo.

## Vedi i conflitti prima del merge {#merge-preview}

Ogni consegna che ti aspetta viene confrontata con il suo branch base **così com’è ora** (l’ultimo `origin/<base>` scaricato), senza toccare il tuo checkout: Git unisce i due in memoria e nel tuo repository non viene scritto nulla. La scheda del rail, il pacchetto di revisione e il live board indicano allora:

- **In conflitto con main in …**: la modifica non si unisce più in modo pulito; i file sono elencati. Appare con l’aspetto di avviso.
- **Collide con il Rail N in …**: un’altra consegna in attesa sulla stessa base cambia le stesse righe, quindi quella unita per seconda andrà in conflitto.
- **main è avanzato di N commit da quando è stato creato questo branch**: la base è andata avanti; valuta di aggiornare il branch prima di decidere.
- **Già in main**: la modifica è già entrata (per esempio dopo uno squash merge).

Sulla bacheca live il risultato è un chip breve (**2 conflitti**, **Si sovrappone a 1 run**, **Base avanzata**) la cui frase completa compare al passaggio del puntatore o con il focus. L’anteprima si aggiorna quando una consegna cambia stato o un run termina. Quando Specrails unisce da solo più risultati, unisce prima quelli che si applicano senza conflitti. Serve Git 2.38 o successivo; con un Git più vecchio l’anteprima dice che non è disponibile.

## Scegliere cosa succede a una consegna {#pr-decision}

Un'esecuzione conclusa ti chiede una sola cosa: cosa fare del risultato. La scheda mostra un pulsante principale per il passo successivo (creare la PR, pubblicarla o verificarla) e, accanto, **Rivedi**, che apre il pacchetto di revisione in linguaggio semplice. Tutto il resto è sotto **Altre azioni**:

- **Passa al branch** porta il branch nella cartella del progetto così puoi provarlo.
- **Integra in locale** unisce il risultato al branch di base su questo computer. Non serve GitHub e confermi prima.
- **Scarta** elimina il risultato e il suo branch. Confermi prima.

Se un'azione fallisce, l'avviso dice cosa non è andato a buon fine e offre **Riprova**.

## Lascia che Specrails tenga verde la PR {#pr-ci}

Dopo che hai creato una PR da una missione, la conversazione offre **Monitora e correggi la CI della PR #N**. È facoltativo e non parte mai da solo. Scegli **Avvia** e Specrails attende i check della PR, corregge quelli che falliscono, risolve i conflitti con il branch di base facendone il merge, verifica il risultato sul tuo computer e invia la correzione alla stessa PR, finché i check non sono verdi. Puoi seguirlo nella striscia delle esecuzioni («In attesa della CI», «Correzione dei check che falliscono», «Invio della correzione alla PR»).

Non fa mai force push, non riscrive mai il branch, non indebolisce mai un check e non pubblica, non fa il merge né chiude la PR: queste decisioni restano tue. Se non riesce a finire (i check continuano a fallire, un check obbligatorio non riporta mai, serve un segreto che solo tu puoi fornire), si ferma e dice perché. **Non ora** nasconde l'offerta per questa consegna. Puoi avviarlo più tardi con **Correggi CI** in **Altre azioni** sulla scheda della PR o sul rail.

## Tastiera

| Tasto | Azione |
| --- | --- |
| `j` / `k` | File modificato successivo / precedente |
| `n` / `p` | Nota del revisore successiva / precedente |
| `v` | Segna il file come visto |

I tasti sono ignorati mentre scrivi in un campo. Segnare un file come visto è privato: se il file cambia in una revisione successiva mostra **Modificato da quando l'hai visto** e torna a contare come non visto.
