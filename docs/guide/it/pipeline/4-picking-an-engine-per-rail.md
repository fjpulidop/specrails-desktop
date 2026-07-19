# Scegliere un engine per ogni rail

Specrails desktop tratta **Claude Code**, **Codex CLI**, **Gemini CLI** e
**Kimi Code** come engine di prima classe. È possibile ogni combinazione compatibile.

## Quando compare il selettore

Il **selettore di engine** vive nell'intestazione del rail, proprio accanto al controllo della modalità. Viene mostrato solo quando il progetto ha installato **più di un** provider.

> **I progetti con un solo provider si comportano in modo byte-identico.** Se un progetto ha un solo engine, non compare alcun selettore e nulla cambia nella selezione del provider — gira semplicemente su quell'engine. Il selettore è pensato esclusivamente per i progetti multi-provider.

Quando compare, la tua scelta è **per rail e per avvio** — rail diversi possono usare engine diversi, e la tua scelta viene ricordata per ogni progetto (con default sull'engine primario del progetto).

## Come scegliere un engine

1. Assicurati che il selettore di engine del rail sia visibile (il progetto ha 2+ provider).
2. Cliccaci sopra e scegli **Claude**, **Codex**, **Gemini** o **Kimi**.
3. Avvia il rail con **▶ Play**.

L'engine selezionato esegue ogni fase della pipeline di quel rail. Se la CLI dell'engine scelto non è installata, l'avvio fallisce subito — non viene avviato nulla. Installa la CLI mancante e riprova.

## In cosa è bravo ciascun engine

Tutti e quattro eseguono **Implement** e **Batch**:

| Engine | Scegli questo quando… | Note |
|--------|--------------------|-------|
| **Claude** | Servono costi nativi, interazione persistente o tool policy rigorose. | Profili, Freestyle e transform strutturati. |
| **Codex** | Preferisci la CLI Codex di OpenAI o vuoi confrontare le implementazioni tra provider diversi. | `codex` ≥ 0.128.0. Nessuna reportistica nativa dei costi — l'app ricava il costo dalla sua tabella prezzi. I profili non si applicano. |
| **Gemini** | Vuoi la CLI Gemini di Google, telemetria nativa o un'esecuzione più economica per le spec di routine. | `gemini` ≥ 0.11.0 (imposta `GEMINI_API_KEY`). Telemetria OTLP nativa. I profili non si applicano. |
| **Kimi** | Vuoi Kimi agentic per Implement, Batch, Freestyle o loop senza Decider. | `kimi` ≥ 0.27.0 esterno; profili/ruoli, effort solo K3; token/costo non disponibili. |

### Differenze di capability

Claude e Kimi supportano profili/Freestyle; Codex/Gemini usano legacy. Kimi
rifiuta Loop Decider e i transform pure-output nella
[guida Kimi](../../../kimi.md). I profili Claude/Kimi restano separati.

## Un flusso di lavoro pratico

I progetti multi-provider danno il meglio quando vuoi **confrontare** o **ottimizzare i costi**:

- **Confronta le implementazioni.** Metti la stessa spec su due rail, imposta uno su Claude e uno su Codex, avviali entrambi (su progetti diversi, oppure uno dopo l'altro nella coda dello stesso progetto), poi usa il pulsante **Confronta** nella pagina Job per mettere a confronto i risultati.
- **Ottimizza i costi per spec.** Esegui le spec ad alto rischio su Claude con un profilo `max`; esegui le spec di pulizia di routine su Gemini per risparmiare. Filtra `/analytics` per engine per vedere la ripartizione.
- **Imposta un default sensato.** Imposta l'engine che usi più spesso come primario del progetto, così i rail partono da quello, e cambia per ogni rail solo quando una spec specifica vuole un engine diverso.

## Cose da tenere a mente

- **La selezione del provider è immutabile dopo la creazione del progetto** (v1). Scegli i provider installati quando aggiungi il progetto; non c'è alcun interruttore nelle Impostazioni per aggiungerne o rimuoverne uno in seguito.
- **Le metriche disponibili sono tracciate.** Kimi non fornisce token/costo USD
  autorevoli; i campi restano vuoti.
- **Il pulsante "Open AI CLI" del terminale** offre anch'esso un selettore di provider sui progetti multi-provider, se preferisci pilotare una CLI a mano.

## Dove andare ora

- [Usare Codex](../integrations/using-codex) — installazione e accesso.
- [Usare Gemini](../integrations/using-gemini) — installazione, `GEMINI_API_KEY`, telemetria.
- [Usare Kimi](../../../kimi.md) — installazione e matrice completa.
- [Rail e job](rails-and-jobs) — la coda e il flusso di avvio.
- [Tracciare i costi](../analytics/tracking-cost) — ripartizione dei costi per engine.
