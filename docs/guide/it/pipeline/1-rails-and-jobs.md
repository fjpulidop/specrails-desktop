# Rail e job

Hai le tue spec sulla board. È qui che si trasformano in codice. Un **rail** è la corsia che porta una spec attraverso l'intera pipeline — Architect → Developer → Reviewer → Ship — eseguendo veri agenti AI dentro la cartella del tuo progetto. Questa pagina spiega come avviare un rail, come funziona la coda dei job e come seguire il lavoro dal vivo mentre accade.

## Cos'è un rail

Immagina lo schermo diviso in due:

```
SpecsBoard (sinistra)       Rail (destra)
─────────────────            ─────────────────
#1 Login flow      ─┐
#2 Webhook retry    │  trascina su
#3 Cost limits      │ ────────────►   Rail 1   ▶ Play
#4 Audit log        │
                    └────────────►   Rail 2   ▶ Play
```

Un rail è una **corsia di esecuzione**. Trascini una scheda spec dalla SpecsBoard su un rail e poi premi **▶ Play**. Il rail avvia la pipeline e lavora la spec dall'inizio alla fine, direttamente nella cartella di lavoro del tuo progetto — modificando file, eseguendo test, tutto quanto.

Puoi avere diversi rail per organizzare il lavoro in corsie con un nome (una per la feature su cui sei concentrato, un'altra in attesa dietro). Trovi più dettagli su multi-rail e batching in [Batch implement e multi-feature](batch-implement-and-multi-feature).

## Avviare un rail su una spec

1. **Trascina una scheda spec** dalla SpecsBoard su un rail. L'ID della spec compare nell'elenco di spec del rail. (Preferisci non trascinare? Usa il popover **Sposta su un rail** sulla scheda spec — mostra un pallino di stato per ogni rail, così non scarichi del lavoro su una corsia già occupata.)
2. **Scegli un Loop** nell'intestazione del rail. Un rail esegue un **Loop** — è il lavoro che svolge. Quello predefinito è il Loop `Implement` integrato; puoi anche scegliere `Batch`, `Ultracode` o un loop personalizzato che hai costruito tu. Vedi [Il Loop Builder](the-loop-builder).
3. **Premi ▶ Play.**

Tutto qui. Il rail avvia un processo CLI AI nel tuo progetto e dà il via alla pipeline.

### Cosa c'è nell'intestazione di un rail

| Controllo | Cosa fa |
|---------|--------------|
| **Pillola di stato** | `idle`, `running` o `failed`. Non esiste uno stato "completed" separato — un rail torna a `idle` quando il suo job termina senza errori. |
| **Elenco spec** | Gli ID assegnati a questo rail. Trascinane altri dentro, oppure fuori per staccarli. |
| **Selettore Loop** | Il Loop che questo rail esegue — uno integrato (`Implement` / `Batch` / `Ultracode`) o un loop personalizzato. Vedi la tabella più sotto. Viene salvato per ogni rail. |
| **Selettore profilo** | Quale profilo agente viene eseguito (solo per i rail Claude). Compare solo quando il progetto ha almeno un profilo. |
| **Selettore engine** | Quale provider installato esegue questo rail — Claude, Codex o Gemini. Viene mostrato solo quando il progetto ha più di un provider. Vedi [Scegliere un engine per ogni rail](picking-an-engine-per-rail). |
| **▶ Play / ■ Stop** | Avvia o annulla. |

### Cosa esegue un rail: i Loop

Un rail esegue un **Loop** — la ricetta del lavoro. Tre loop sono **integrati** e coprono i casi più comuni:

| Loop integrato | Comando | Cosa fa |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | Un unico job che copre tutte le spec sul rail. Esegue l'intera pipeline Architect → Developer → Reviewer → Ship. L'impostazione predefinita di tutti i giorni. |
| **Batch** | `/specrails:batch-implement` | Un unico job che lavora le spec del rail in sequenza, in ondate consapevoli delle dipendenze. Ideale per più spec correlate. |
| **Ultracode** | Ultracode | Claude implementa ogni spec in autonomia, **bypassando** la pipeline. Un job indipendente per ogni spec. Solo Claude. |

Ultracode è il caso a sé stante: salta la catena di agenti e affida a Claude la spec grezza, lasciandolo lavorare con i suoi strumenti nativi. È a finalità aperta, quindi premendo Play si apre prima una conferma, e un selettore di modello per rail ti permette di scegliere tra Haiku / Sonnet / Opus. Compare solo quando l'engine del rail è Claude.

Oltre agli integrati, puoi **costruire i tuoi loop** — ripetere un ciclo verify → fix → verify finché un obiettivo non è raggiunto, concatenare comandi shell tra gli AI Step e altro ancora. Quei loop personalizzati compaiono nello stesso selettore Loop. È la prossima grande idea: [Il Loop Builder](the-loop-builder).

## La coda dei job

Ogni volta che premi Play, l'esecuzione del rail diventa un **job**. La regola più importante da fare propria:

> **Un job alla volta, per progetto.** Ogni progetto ha un'unica coda. All'interno di un progetto viene eseguito un solo job di rail alla volta — gli altri si mettono in coda dietro e partono automaticamente man mano che si liberano gli slot.

Questo sorprende chi aggiunge tre rail aspettandosi che vadano in parallelo. Non succede — non all'interno dello stesso progetto. Aggiungere rail *organizza* il tuo lavoro in corsie; non fa sì che quelle corsie vadano in contemporanea.

**Il vero parallelismo è tra progetti diversi.** Ogni progetto ha la sua coda indipendente, quindi un rail nel Progetto A e un rail nel Progetto B vengono eseguiti nello stesso momento senza contendersi le risorse. Vuoi più throughput? Apri più progetti.

Non c'è una manopola globale di concorrenza da regolare. L'unico freno automatico è basato sul budget: se hai impostato un budget giornaliero (di progetto o per tutta l'app), la coda si mette automaticamente in pausa quando la spesa della giornata raggiunge il limite.

## Seguire l'esecuzione

Trovi ogni job in **Job**, nella barra laterale destra del progetto — un elenco di schede, dalla più recente. Ogni scheda mostra un badge di stato, il badge del profilo, un badge di priorità, la durata, il costo e il comando avviato. Sopra l'elenco:

- **Chip di filtro per stato** — mostra solo i job in un determinato stato.
- **Filtro per intervallo di date** — restringi a una finestra temporale.
- **Confronta** — scegli due job e visualizzali fianco a fianco.

Clicca su una scheda qualsiasi per aprire la **vista Dettaglio job**, dove vivono il log in streaming in tempo reale e le metriche live. È la pagina successiva: [La vista Dettaglio job](the-job-detail-view).

## Annullare un job

Clicca su **■ Stop** nell'intestazione del rail. L'app invia `SIGTERM` al sottoprocesso, attende **5 secondi** un'uscita pulita e poi gli invia `SIGKILL`. Niente resta avviato a metà.

## Se un rail non parte

Se scegli un engine la cui CLI non è installata sulla tua macchina, l'avvio **fallisce subito** invece di avviare un job difettoso — non viene avviato nulla. Installa la CLI del provider mancante ([Usare Codex](../integrations/using-codex), [Usare Gemini](../integrations/using-gemini)) e riprova ad avviare. Se mancano Claude o Codex compare un messaggio preciso "*&lt;provider&gt; CLI not found*"; se manca Gemini oggi viene mostrato un errore di avvio generico, ma il risultato è lo stesso.

## Fermare tutto

Se qualcosa sembra non andare:

- **Un solo rail** — clicca su **■ Stop** nella sua intestazione.
- **Pausa automatica sul budget** — imposta un budget giornaliero e la coda si mette in pausa da sola quando la spesa della giornata raggiunge il limite.
- **Tutto** — chiudi l'app desktop, oppure esegui `specrails-desktop stop`.

## Dove andare ora

- [Il Loop Builder](the-loop-builder) — cosa esegue un rail e come costruire i tuoi loop.
- [La vista Dettaglio job](the-job-detail-view) — fasi, metriche live, schede ticket.
- [Batch implement e multi-feature](batch-implement-and-multi-feature) — esegui più spec insieme.
- [Scegliere un engine per ogni rail](picking-an-engine-per-rail) — Claude vs Codex vs Gemini.
