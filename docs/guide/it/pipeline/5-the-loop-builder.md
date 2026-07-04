# Il Loop Builder

Un **rail esegue un Loop**. I loop integrati (`Implement`, `Batch`, `Freestyle`) coprono i casi di tutti i giorni, ma il **Loop Builder** ti permette di progettare i tuoi — un editor visuale in stile n8n per automazioni che si ripetono finché un obiettivo non è raggiunto. Questa pagina spiega cos'è un loop, come costruirne uno e come eseguirlo su un rail.

## Loop e rail — la relazione

Un **loop** è la *ricetta* del lavoro; un **rail** è la *corsia* che lo esegue sulle tue spec.

```
   Loop Builder (sidebar sinistra)         Rail (destra)
   ───────────────────────────             ─────────────
   Implement   (integrato)                 Rail 1
   Batch       (integrato)     scegli su ►    Loop: Verify-until-green
   Freestyle   (integrato)                    ▶ Play
   Verify-until-green (tuo)
```

- I loop vivono nella sezione **Loops** (sidebar sinistra, accanto ai tuoi progetti) — sono **globali**, condivisi tra tutti i progetti.
- Un rail **sceglie un loop** nel suo header (il selettore Loop) e lo esegue quando premi Play.
- È il **rail** a decidere provider, modello e reasoning effort — *non* gli step del loop. Lo stesso loop gira su Claude, Codex o Gemini a seconda del rail.

Quindi: costruisci un loop una volta, poi scegli quel loop su qualsiasi rail in qualsiasi progetto.

## Aprire il builder

Clicca **Loops** nella sidebar sinistra per vedere la libreria: i tre loop integrati più tutti i tuoi. Aprine uno per visualizzarlo, oppure clicca **New loop** per partire da una tela bianca.

Non puoi modificare facilmente un integrato in modo diretto — invece fanne un **Fork**. Ti dà una copia modificabile di un grafo funzionante da cui partire, ed è il modo più semplice per imparare.

## Di cosa è fatto un loop

Un loop è un grafo di **nodi** collegati da **archi** (le frecce). Ogni nodo è uno step:

| Nodo | Cosa fa |
|------|--------------|
| **Start** | Dove inizia l'esecuzione. Esattamente uno per loop. |
| **AI Step** | Esegue un turno AI — un prompt che scrivi tu, o un *magic command* come `{{cmd:implement}}`, `{{cmd:verify}}`, `{{cmd:fix}}`. È qui che accade il lavoro vero. |
| **Shell** | Esegue un comando shell (es. `npm test`) e ne cattura l'output per gli step successivi. |
| **Loop Decider** | Il cervello di un loop. A ogni passaggio legge un **obiettivo** che scrivi tu e decide **continue** (torna indietro e riprova) o **stop** (esci). È ciò che alimenta *verify → fix → verify finché non è verde*. |
| **End** | Un nodo terminale. Marca l'esecuzione come successo o fallimento. |

Gli archi collegano gli step in ordine. Il **Loop Decider** ha due uscite etichettate — **continue** e **stop** — così colleghi "non ancora finito" di nuovo nel lavoro e "fatto" verso un End.

### Scrivere il testo di uno step

Dentro qualsiasi AI Step o Decider puoi fare riferimento a:

- **Dati della spec** — `{{spec.title}}`, `{{spec.description}}`, `{{spec.ids}}` (gli ID dei ticket del rail). Riempiti dalle spec sul rail al momento dell'esecuzione.
- **Magic command** — `{{cmd:implement}}` e simili si espandono nel comando della pipeline corrispondente.
- **Costanti** — `{{const:NAME}}` attinge dalla **libreria di costanti** globale (trascinale dalla palette). Sentinelle integrate come i marcatori PASS/FAIL di verifica sono sempre disponibili; puoi aggiungere le tue e riusarle in ogni loop.

## Tenere un loop entro i limiti

Un loop che non si ferma mai brucerebbe soldi per sempre, quindi ogni esecuzione ha tre guardie (impostate nella toolbar del builder):

| Guardia | Cosa fa |
|-------|--------------|
| **Max iterations** | Tetto massimo di quante volte il Decider può tornare indietro, indipendentemente dal suo verdetto. |
| **Timeout (min)** | Limite di tempo reale per l'intera esecuzione. |
| **Max cost ($)** | *Opzionale.* Ferma il loop quando il costo accumulato supera il tuo budget. Controllato **tra uno step e l'altro** (il costo di uno step si conosce solo quando finisce), quindi può sforare di uno step. Su Claude il costo è esatto; su Codex e Gemini è una stima. Lascialo vuoto per nessun tetto. |

## Costruire con sicurezza

Il builder ti aiuta a far girare bene un loop prima ancora che venga eseguito:

- **Validazione dal vivo** — i problemi (nessuno Start, uno step orfano, un prompt vuoto, un Decider con rami mancanti) sono segnalati sulla tela e in un pannello dei problemi.
- **Anteprima dry-run** — risolve il testo esatto di ogni step (dati della spec, costanti, comandi tutti espansi) **senza avviare nulla**, così vedi con precisione cosa invierebbe ogni step.
- **Auto-arrange** — riordina la tela in verticale, orizzontale o a griglia; la tua scelta è salvata per loop.
- **Copia / incolla** — `Cmd/Ctrl + C` / `V` per copiare step dentro o tra i loop.
- **Import / export** — salva i loop in un file `.json` e reimportali (i nomi duplicati vengono saltati, il resto viene importato).
- **Rinomina step** — dai a ogni nodo un'etichetta personalizzata così il grafo si legge chiaro.

## Pubblicare ed eseguire

Un loop nasce come **Draft**. Quando il grafo è valido, fai **Publish** — i loop pubblicati sono quelli che compaiono nel selettore Loop di un rail. (Fai Unpublish per toglierlo dalla circolazione senza eliminarlo.)

Per eseguire un loop personalizzato:

1. Apri un progetto e trascina una spec su un rail.
2. Nell'header del rail, apri il **selettore Loop** e scegli il tuo loop pubblicato.
3. Premi **▶ Play**.

L'esecuzione scorre dal vivo nella vista **Jobs** con le stesse metriche e lo stesso tracciamento del costo di qualsiasi job di rail — e il suo log guadagna un **esploratore di passi** dedicato: una mappa live del tuo grafo con una scatola richiudibile per passo, che segue il passo in esecuzione man mano che il loop avanza (vedi [La vista Dettaglio job](the-job-detail-view)). Su Claude, ogni **Passo AI** è anche una sessione live: mandagli messaggi dal composer del Dettaglio job per orientarlo a metà passo (tra un passo e l'altro il composer attende brevemente, e **Assesta questo passo** fa avanzare il loop con ciò che il passo ha prodotto). Un loop che si ferma perché ha raggiunto il suo tetto di iterazioni o di costo viene riportato con quell'esito anziché con un semplice successo.

> **Attenzione mentre un loop gira.** Non puoi modificare o eliminare un loop mentre una delle sue esecuzioni è in corso — ferma prima l'esecuzione.

## Dove andare poi

- [Rail e job](rails-and-jobs) — avviare i rail e la coda dei job.
- [La vista Dettaglio job](the-job-detail-view) — seguire un'esecuzione dal vivo.
- [Scegliere un engine per rail](picking-an-engine-per-rail) — è il rail (non il loop) a scegliere il provider.
