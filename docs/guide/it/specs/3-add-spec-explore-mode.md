# Aggiungi spec — Modalità Explore

La modalità Explore è una conversazione. Invece di scrivere tu stesso la spec, ragioni sull'idea insieme all'AI — che fa da partner di pensiero, pone domande, propone una struttura e costruisce una **bozza live** della spec man mano che procedete. Quando sei soddisfatto, confermi la bozza trasformandola in una spec vera e propria.

Scegli Explore quando l'idea non è ancora del tutto definita, quando ci sono compromessi da discutere o quando vuoi che l'AI guardi il tuo codice reale prima di fissare la spec.

## Creare una spec in modalità Explore

Per dare forma a una spec in modalità Explore:

1. Nella Dashboard, clicca su **Aggiungi**, poi scegli **Explore**.
2. Scrivi il tuo primo messaggio — l'idea, una domanda o un pensiero ancora abbozzato.
3. Leggi la risposta dell'AI e continua a rispondere. A ogni turno affina la sua comprensione.
4. Osserva la **bozza live** aggiornarsi accanto alla chat — è la spec che prende forma.
5. Quando la bozza ti sembra giusta, clicca su **Crea spec**.

La conversazione resta nella tua cronologia, così puoi sempre tornarci per vedere come è stata modellata la spec.

## La bozza live

Mentre converssi, un pannello mostra la bozza così com'è in quel momento — titolo, descrizione, priorità, etichette, criteri di accettazione. Si riscrive a ogni turno in base a ciò che avete discusso. Non la modifichi direttamente; la guidi attraverso la conversazione ("anzi, metti la priorità alta", "aggiungi un criterio sulla gestione degli errori", e così via).

Questo è il cuore della modalità Explore: non ti trovi mai davanti a un form vuoto. Stai sempre guardando una spec reale, in evoluzione.

## Quanto vede l'AI: lo slider del contesto

Prima che l'AI risponda, decidi tu quanto del tuo progetto può vedere. Uno slider di preset di contesto ti permette di scambiare velocità con profondità:

| Preset | Cosa vede l'AI |
|--------|------------------|
| **Minimo** | Solo il tuo messaggio. Il più veloce ed economico. |
| **Leggero** | + le tue spec esistenti. |
| **Standard** | + le tue spec e le spec OpenSpec del tuo progetto. |
| **Ricco** | + accesso in lettura all'intero codebase, così può ancorare le risposte al codice reale. |
| **Max** | Ricco, più un passaggio di arricchimento Contract Layer alla conferma. |
| **Desktop** | Max, più i server MCP del tuo progetto e i tuoi server MCP approvati. |

Parti da un livello basso per un brainstorming veloce; sali quando vuoi che l'AI verifichi i suoi suggerimenti rispetto al tuo codice reale. La scelta viene salvata sulla conversazione, così non si riversa su altre sessioni Explore.

Se vuoi un controllo più fine, clicca su **Fine-tune** per attivare manualmente le opzioni sottostanti — incluso **I miei MCP approvati**, che carica i server MCP che hai già approvato localmente senza rallentare la sessione.

## Pulsanti nella shell Explore

- **Crea spec** — promuove la bozza live a una spec vera e propria con stato **Da fare**. (Quando stai modificando una spec esistente, questo pulsante diventa **Aggiorna spec** e modifica quella spec sul posto.)
- **Rivedi →** — apre un overlay di revisione che mostra la spec proposta confrontata con la baseline prima di confermare, così niente sorprese.
- **Salva come bozza** — conserva la conversazione come ticket bozza per riprenderla in seguito. Disponibile non appena hai inviato almeno un messaggio. Vedi sotto.
- **Riduci** — parcheggia la conversazione come chip nel dock delle chat ridotte in basso a sinistra. Clicca sul chip in qualsiasi momento per tornare dritto nella conversazione — non si perde nulla.
- **Scarta** — getta via la conversazione (chiede prima conferma).

## Salvare come bozza

Non sei pronto a confermare, ma non vuoi perdere il ragionamento? Clicca su **Salva come bozza**. La conversazione diventa una **spec bozza** sulla tua board, e la bozza resta collegata alla conversazione che le sta dietro.

In seguito, apri la bozza dalla board e clicca su **Continua a modificare** — la conversazione originale si riapre con la sua cronologia chat intatta, e riprendi esattamente da dove avevi lasciato. Le bozze non vengono mai eliminate automaticamente; ti aspettano.

Questo rende Explore sicuro da usare per idee ancora acerbe: avvii una conversazione, arrivi da qualche parte, la salvi come bozza e torni domani.

Per tutto ciò che riguarda le bozze — incluso l'arricchimento Contract Layer — consulta [Le bozze e il Contract Layer](drafts-and-contract-layer.md).

## Nota multi-provider

Se il tuo progetto ha installato più di un provider AI, un selettore di engine ti permette di scegliere quale guida la conversazione Explore. I progetti con un solo provider non lo mostrano.

## Dove andare adesso

- [Le bozze e il Contract Layer](drafts-and-contract-layer.md) — salvare il lavoro in corso e arricchire le spec per la pipeline.
- [Aggiungi spec — Modalità Quick](add-spec-quick-mode.md) — quando l'idea è già chiara.
- [Esecuzione delle pipeline](running-pipelines.md) — realizza la tua spec una volta che è pronta.
