# Aggiungere il tuo primo progetto

Un progetto è semplicemente una cartella sul tuo computer che contiene un codebase. Colleghiamone uno.

## Apri la finestra Aggiungi progetto

Fai clic su **Aggiungi il tuo primo progetto** nella schermata di benvenuto (o sul pulsante **Aggiungi progetto** nella barra laterale sinistra più avanti). Appare una piccola finestra.

## Compila i dettagli

**Cartella del progetto** *(obbligatorio)*

Indica a specrails la cartella che contiene il tuo codice. Nell'app desktop puoi fare clic sull'icona della cartella per sfogliare e sceglierla visivamente, oppure incollare il percorso completo. Deve essere la radice del tuo repository — la cartella che contiene il codice e (di solito) una directory `.git`.

**Nome del progetto** *(facoltativo)*

Un'etichetta amichevole mostrata nella barra laterale. Se lo lasci vuoto, specrails usa il nome della cartella.

> Un controllo rapido viene eseguito in background per confermare che gli strumenti richiesti siano presenti. Se manca qualcosa di essenziale, il pulsante **Aggiungi** resta disabilitato e un link **Più info** ti fornisce i comandi di installazione esatti.

Questo è tutto il modulo — fai clic su **Aggiungi** e hai finito.

## I provider IA vengono rilevati automaticamente

Non scegli più i provider. Specrails rileva ogni CLI di IA installata sulla tua macchina — **Claude**, **Codex**, **Gemini**, **Kimi** — e ogni progetto può usarli tutti, sempre. Installa un nuovo provider in seguito e apparirà ovunque da solo la prossima volta che torni sull'app; nessuna riconfigurazione, nessuna impostazione per progetto. Se un provider è installato ma non connesso, il suo selettore mostra un badge discreto *Non connesso*.

## La configurazione avviene in silenzio

Non c'è alcuna procedura guidata. Nel momento in cui fai clic su **Aggiungi**, il progetto è registrato e appare nella barra laterale — puoi aprirlo subito. In background, specrails assembla il workspace del progetto (pochi secondi, completamente offline): un piccolo punto pulsante sulla riga del progetto indica che sta lavorando, e scompare quando tutto è pronto. Se qualcosa fallisce per un provider, il progetto continua a funzionare con gli altri — appare un punto ambra e un clic riprova.

## Cosa viene installato — e dove

La configurazione è deliberatamente **non invasiva**: il tuo repository resta intatto. Tutti gli artefatti di specrails (definizioni degli agenti, comandi, profili, impostazioni locali) vivono in un workspace per progetto sotto la tua home directory, collegato a un'unica installazione condivisa del framework fornita con l'app. Il tuo repo non viene mai modificato — e quando l'app si aggiorna, ogni progetto riceve automaticamente il nuovo framework, tutto in una volta.

> **Preferisci la configurazione approfondita?** L'app include di proposito l'installazione rapida con template. Se preferisci il flusso arricchito dall'IA (analisi del codebase e persona degli agenti personalizzate), puoi eseguire `npx specrails-core@latest init` dalla cartella del progetto in un terminale.

## Sei dentro

La dashboard del progetto è disponibile nel momento in cui fai clic su **Aggiungi**. È ora del tour — vedi [Il tour della dashboard](the-dashboard-tour).
