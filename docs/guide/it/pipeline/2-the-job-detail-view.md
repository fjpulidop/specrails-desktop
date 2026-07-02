# La vista Dettaglio job

Clicca su una qualsiasi scheda job nella pagina **Job** e arrivi qui: la cabina di pilotaggio di una singola esecuzione di rail. È costruita attorno a una promessa — **i numeri live che vedi sono reali, mai ipotesi.** Questa pagina ti accompagna tra le fasi, le metriche live e le schede ticket.

## Il layout

Due pannelli stanno sopra il log completo in streaming:

```
┌─────────────────────────────────────────────┐
│  Intestazione di stato (icona · durata live · …) │
├─────────────────────────────────────────────┤
│  Intestazione ticket  ( #12  #14  #15 )     │
├─────────────────────────────────────────────┤
│                                             │
│  Log in streaming (auto-scroll · ricerca · …) │
│                                             │
└─────────────────────────────────────────────┘
```

## Fasi della pipeline

Per i job `Implement` e `Batch`, l'esecuzione attraversa le fasi definite dallo slash command — per impostazione predefinita:

```
Architect ──► Developer ──► Reviewer ──► Ship
```

Ogni fase è un agente specializzato che l'engine del rail invoca nella cartella del tuo progetto:

| Fase | Agente | Cosa fa |
|-------|-------|--------------|
| **Architect** | `sr-architect` | Pianifica l'implementazione. |
| **Developer** | `sr-developer` | Scrive il codice. |
| **Reviewer** | `sr-reviewer` | Revisiona il risultato. |
| **Ship** | (variabile) | Conclusione finale: test, commit, bozza di PR. |

Quale agente gestisce ogni fase lo decide il **profilo agente** del progetto. Il trio di base (`sr-architect`, `sr-developer`, `sr-reviewer`) è sempre presente; le regole di routing in un profilo possono aggiungere agenti o cambiare quale di essi esegue una fase. La barra di avanzamento delle fasi compare solo quando il comando definisce effettivamente delle fasi — i job Freestyle (che bypassano la pipeline) non ne mostrano alcuna.

## Metriche live — oneste per scelta

L'intestazione di stato è il titolo principale. Mostra un'icona di stato, una riga di attività che descrive cosa sta facendo il job *in questo momento*, un conteggio dei passi compiuti e una riga di metriche:

| Metrica | Quando vedi il valore reale |
|--------|------------------------------|
| **Durata** | **Live.** Un ticker da 1 secondo conta in avanti mentre il job è in esecuzione — è l'unico numero davvero live. |
| **Turni** | Derivati in modo incrementale dagli eventi assistant in streaming man mano che arrivano. |
| **Token** | Aggregati in modo incrementale dallo stesso stream (tollera gli eventi privi dei campi di utilizzo). |
| **Costo** | Mostrato come `—` finché il job non termina, poi rivelato come l'autorevole `total_cost_usd`. |

Il principio di progettazione: **nessun numero approssimato o stimato durante l'esecuzione.** La durata è reale perché è semplicemente un orologio. Turni e token vengono accumulati dall'attività realmente trasmessa in streaming. Il costo deliberatamente *non* viene stimato durante l'esecuzione — appare come in attesa e si risolve solo nel suo valore finale e autorevole quando il provider lo riporta all'uscita del job. Se un numero sembra in attesa, è intenzionale — ti viene mostrata la verità, non una proiezione.

L'etichetta e l'icona dell'intestazione corrispondono allo stato del job, e il pannello viene mostrato per i job `running`, `completed` e `failed` allo stesso modo — così la vista di dettaglio di un job concluso mostra le stesse metriche congelate ai loro valori finali.

## Le schede ticket

L'**intestazione ticket** sta tra l'intestazione di stato e il log. È una scheda d'identità premium che mostra un chip per ogni spec toccata dal job — ricavati dal comando avviato, così riflette esattamente quali ticket riguardava questa esecuzione.

- **2–3 ticket** — mostrati come elenco di chip.
- **4 o più** — si comprimono in una modalità compatta `+ N more` con un chevron per espandere, così l'intestazione resta ordinata.

Cliccando su un chip si apre il dettaglio di quella spec **sopra la pagina del job** — non perdi il segno né cambi pagina. È un modo rapido per rileggere cosa un job dovrebbe consegnare mentre lo guardi lavorare. (Sugli schermi in formato tablet puoi persino trascinare di lato una modale ticket per confrontare due spec fianco a fianco.)

## Il log in streaming

Sotto i pannelli c'è il log completo dell'esecuzione, trasmesso in tempo reale tramite WebSocket:

- L'**auto-scroll** mantiene in vista l'output più recente (scorri verso l'alto e si mette in pausa così puoi leggere).
- La **ricerca** per saltare a una frase.
- **Copia** per prendere l'intero log.

Questa è la verità grezza di ciò che l'AI sta facendo — ogni chiamata a uno strumento, ogni modifica a un file, ogni test eseguito.

## Esportazione diagnostica

Se la [telemetria](../settings/customizing) era abilitata per il job, nell'intestazione compare un pulsante **Esporta diagnostica**. Scarica uno ZIP che contiene:

- `job-metadata.json` — comando, stato, profilo, plugin.
- `telemetry.ndjson` — segnali OTLP/JSON non compressi.
- `logs.txt` — il log completo in streaming.
- `summary.md` — i punti salienti in formato leggibile.
- `profile.json`, `plugins.json` — snapshot esatti di ciò che è stato eseguito (quando presenti).

Comodo per condividere un'esecuzione con un collega, o per inviare una segnalazione di bug precisa.

## Dove andare ora

- [Rail e job](rails-and-jobs) — avvio e accodamento.
- [Batch implement e multi-feature](batch-implement-and-multi-feature) — molte spec, ondate di dipendenze.
- [Tracciare i costi](../analytics/tracking-cost) — trasforma i costi per job in analytics di progetto.
