# Telemetria della pipeline e diagnostica

Quando un job della pipeline non va come ti aspettavi, la telemetria ti offre un resoconto dettagliato e dietro le quinte di ciò che la AI CLI ha realmente fatto. È **disattivata per impostazione predefinita** e completamente opzionale, per ogni progetto — attivala solo quando ti serve.

## Cos'è

La telemetria cattura segnali diagnostici strutturati (traces, metriche e log) emessi dalla AI CLI mentre esegue un job della pipeline. Pensala come una scatola nera per le tue esecuzioni della pipeline: tempistiche, uso dei token e attività passo dopo passo, catturati localmente così da poter ispezionare un job a posteriori.

È costruita su **OpenTelemetry**, un formato aperto e standard — quindi i dati non restano rinchiusi in una scatola proprietaria.

## Come attivarla

La telemetria si configura **per singolo progetto**:

1. Apri la pagina **Impostazioni** del progetto (la route delle impostazioni di progetto).
2. Trova l'interruttore **Telemetria della pipeline**.
3. Attivalo.

Da quel momento in poi, i job della pipeline in quel progetto registrano la telemetria. Gli altri progetti non ne sono toccati — ciascun progetto decide per conto suo.

### Cosa viene coperto

La telemetria si applica ai **job della pipeline** (le esecuzioni dei rail Architect → Developer → Reviewer → Ship messi in coda). Le sessioni interattive come la chat e il wizard di setup sono lasciate fuori di proposito — la telemetria è pensata per le esecuzioni ripetibili e ispezionabili della pipeline, non per le conversazioni occasionali.

## Dove vivono i dati

Tutto resta sulla tua macchina, sotto la tua home directory (`~/.specrails/`) — mai nel tuo repository. Le registrazioni grezze sono salvate in forma compressa accanto al loro job e, dopo una settimana, quelle più vecchie vengono automaticamente condensate in riassunti compatti per mantenere tutto in ordine. Non devi mai gestire nulla di tutto questo a mano.

## Esportare un bundle diagnostico

La cosa più utile che la telemetria sblocca è l'**export diagnostico** — un singolo ZIP che racchiude tutto ciò che riguarda un job, per il troubleshooting o per condividerlo.

Quando un job ha la telemetria registrata, sulla sua card compare un **pulsante di esportazione**. Cliccalo per scaricare uno ZIP contenente:

- **`job-metadata.json`** — l'identità e i parametri del job
- **`telemetry.ndjson`** — i segnali grezzi registrati
- **`logs.txt`** — l'output di log catturato
- **`summary.md`** — un riassunto leggibile dell'esecuzione

Se il progetto usa plugin, il bundle include anche uno snapshot di quali plugin erano attivi per quel job.

Questo è il bundle da prendere quando vuoi capire un'esecuzione complicata, conservare una traccia o passare i dettagli a qualcuno che ti aiuta con il debug.

## Come disattivarla

Riporta l'interruttore su off in qualsiasi momento. I nuovi job smettono di registrare immediatamente. Tutto ciò che è già stato catturato resta su disco finché non viene compattato o non rimuovi il progetto — niente viene inviato da nessuna parte né perso alle tue spalle.
