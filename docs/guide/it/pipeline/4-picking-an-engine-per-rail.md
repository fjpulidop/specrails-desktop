# Scegliere un engine per ogni rail

## Quando compare il selettore

Il **selettore di engine** vive nell'intestazione del rail, proprio accanto al controllo della modalità. Viene mostrato solo quando il progetto ha installato **più di un** provider.

> **I progetti con un solo provider si comportano in modo byte-identico.** Se un progetto ha un solo engine, non compare alcun selettore e nulla cambia nella selezione del provider — gira semplicemente su quell'engine. Il selettore è pensato esclusivamente per i progetti multi-provider.

Quando compare, la tua scelta è **per rail e per avvio** — rail diversi possono usare engine diversi, e la tua scelta viene ricordata per ogni progetto (con default sull'engine primario del progetto).

## Come scegliere un engine

L'engine selezionato esegue ogni fase della pipeline di quel rail. Se la CLI dell'engine scelto non è installata, l'avvio fallisce subito — non viene avviato nulla. Installa la CLI mancante e riprova.

## In cosa è bravo ciascun engine

Tutti e quattro eseguono **Implement**:

| Engine | Scegli questo quando… | Note |
|--------|--------------------|-------|
| **Claude** | Servono costi nativi, interazione persistente o tool policy rigorose. | Profili, Freestyle e transform strutturati. |
| **Codex** | Preferisci la CLI Codex di OpenAI o vuoi confrontare le implementazioni tra provider diversi. | `codex` ≥ 0.128.0. Nessuna reportistica nativa dei costi — l'app ricava il costo dalla sua tabella prezzi. I profili non si applicano. |

## Un flusso di lavoro pratico

I progetti multi-provider danno il meglio quando vuoi **confrontare** o **ottimizzare i costi**:

- **Confronta le implementazioni.** Metti la stessa spec su due rail, imposta uno su Claude e uno su Codex, avviali entrambi (su progetti diversi, oppure uno dopo l'altro nella coda dello stesso progetto), poi usa il pulsante **Confronta** nella pagina Job per mettere a confronto i risultati.
- **Imposta un default sensato.** Imposta l'engine che usi più spesso come primario del progetto, così i rail partono da quello, e cambia per ogni rail solo quando una spec specifica vuole un engine diverso.

## Cose da tenere a mente

- **La selezione del provider è immutabile dopo la creazione del progetto** (v1). Scegli i provider installati quando aggiungi il progetto; non c'è alcun interruttore nelle Impostazioni per aggiungerne o rimuoverne uno in seguito.
- **Il pulsante "Open AI CLI" del terminale** offre anch'esso un selettore di provider sui progetti multi-provider, se preferisci pilotare una CLI a mano.

## Dove andare ora

- [Usare Codex](../integrations/using-codex) — installazione e accesso.
- [Rail e job](rails-and-jobs) — la coda e il flusso di avvio.
- [Tracciare i costi](../analytics/tracking-cost) — ripartizione dei costi per engine.
