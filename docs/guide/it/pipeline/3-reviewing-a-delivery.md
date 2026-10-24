<!-- guide-revision: mission-first-v1 -->

# Rivedi una consegna nell'app {#review-a-delivery}

Una consegna pronta per la revisione ha due viste: **Panoramica** (il verdetto, le prove e i pulsanti di decisione) e **Modifiche** (ciò che la consegna ha davvero cambiato). Apri la revisione dal pulsante **Rivedi** della consegna e scegli **Modifiche**.

## Leggi le modifiche

L'elenco dei file a sinistra mostra ogni file modificato con il suo stato (aggiunto, modificato, eliminato, rinominato), i conteggi di righe `+` e `−` e un segno quando lo contrassegni come visto. Il diff a destra carica un file alla volta, quindi anche una modifica grande resta fluida. Passa tra i layout **Unificato** e **Affiancato**; Specrails ricorda la tua scelta. Un file molto grande mostra le prime righe con **Carica il diff completo del file**; un file binario è indicato come binario.

Le modifiche sono misurate dal punto in cui la consegna si è staccata dal branch di base, quindi ciò che è arrivato sulla base dopo non compare. Se la consegna non ha ancora un branch combinato, puoi scegliere il branch di quale spec leggere.

## Note del revisore sul codice

I rilievi del revisore, i rischi segnalati e i commenti di revisione che l'esecuzione doveva risolvere compaiono sotto la riga a cui si riferiscono. Le note che non indicano file né riga sono elencate sopra l'elenco dei file, quindi nulla resta nascosto. Le consegne più vecchie, e i revisori che non hanno indicato un punto, mostrano i rilievi in quell'elenco.

## Chiedi all'agente di cambiare qualcosa

Seleziona le righe cliccando sui loro numeri (Maiusc-clic estende l'intervallo), scegli **Chiedi all'agente di cambiare questo** e descrivi la modifica. Specrails la salva come feedback di revisione sulla spec, con il file, l'intervallo di righe e il codice selezionato, e mostra un messaggio con un link alla spec. La prossima esecuzione su quella spec lo riceverà. Per avviarla subito usa **Chiedi modifiche** nella Panoramica. Qui non ci sono thread di commenti tra persone; confrontati con il tuo team su GitHub.

## Aprilo nel tuo editor

**Apri nell'editor** apre il file, alla riga selezionata, in VS Code, Cursor o in un IDE JetBrains. Scegli l'editor in **Impostazioni → Codice → Editor**. Il file si apre dalla tua copia del progetto, dove il branch della revisione potrebbe non essere attivo.

## Tastiera

| Tasto | Azione |
| --- | --- |
| `j` / `k` | File modificato successivo / precedente |
| `n` / `p` | Nota del revisore successiva / precedente |
| `v` | Segna il file come visto |

I tasti sono ignorati mentre scrivi in un campo. Segnare un file come visto è privato: se il file cambia in una revisione successiva mostra **Modificato da quando l'hai visto** e torna a contare come non visto.
