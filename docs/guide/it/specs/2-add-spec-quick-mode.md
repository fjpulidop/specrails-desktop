# Aggiungi spec — Modalità Quick

La modalità Quick è pensata per quando sai già cosa vuoi. Scrivi la tua idea, l'AI redige la spec completa e questa atterra sulla tua board come **Da fare**. Niente botta e risposta — basta descriverla e partire.

## Creare una spec in modalità Quick

Per creare rapidamente una spec:

1. Nella Dashboard, clicca su **Aggiungi** (il pulsante Più nella toolbar della SpecsBoard).
2. Scegli la modalità **Quick**.
3. Scrivi la tua idea nel campo di testo — una frase o un paragrafo, qualunque cosa la descriva.
4. Clicca per generare.

Mentre la spec viene scritta, un piccolo toast nell'angolo mostra il nome del progetto, un frammento della tua idea e il **tempo trascorso** ("Generazione… 0:12"). Al termine, il toast passa a "Generata in <tempo>" con un'azione **Vedi** che ti porta direttamente alla nuova spec.

Questo è tutto il flusso. Tutto ciò che segue è una rifinitura facoltativa.

## Cosa puoi regolare

**Modello** — per impostazione predefinita l'AI sceglie un modello sensato. Puoi sovrascriverlo per ogni spec dal selettore di modello, se ne vuoi uno più veloce o più capace.

**Engine** — se il tuo progetto ha installato più di un provider AI (una qualsiasi combinazione di Claude, Codex e Gemini), un selettore di engine si trova in cima al dialog, così puoi scegliere quale generi questa spec. La tua scelta viene ricordata per ogni progetto. I progetti con un solo provider non lo mostrano — non c'è nulla tra cui scegliere.

**Contesto** — la modalità Quick di solito viene eseguita come un singolo turno, perché non ha bisogno di leggere il tuo codebase per scrivere una spec a partire dalla tua descrizione. Ma uno slider di contesto ti permette di darle più materiale su cui lavorare:

- Al livello più basso legge solo la tua descrizione.
- Ai livelli più alti può leggere le tue spec esistenti, le spec OpenSpec del tuo progetto e persino l'intero codebase prima di scrivere.

Più contesto le dai, più tempo richiede la generazione (passa a multi-turno per poter leggere prima), ma la spec torna ancorata al tuo progetto reale. Punta a un contesto più alto quando la spec deve far riferimento a codice reale, nomi di file o comportamenti esistenti.

**Allegati** — trascina mockup, brief o file di dati nel campo dell'idea. L'AI li legge come parte della scrittura della spec. (Anche gli allegati fanno passare la generazione a multi-turno.)

**Arricchisci con Contract Layer** — un toggle che aggiunge un blocco strutturato alla spec generata, così la pipeline a valle non deve indovinare nomi o forme dei dati. È facoltativo e disattivato per impostazione predefinita; la tua ultima scelta viene ricordata per ogni progetto. Consulta [Le bozze e il Contract Layer](drafts-and-contract-layer.md) per scoprire cosa aggiunge e quando vale la pena.

## Quando usare la modalità Quick e quando Explore

Usa **Quick** quando l'idea è già chiara nella tua testa — potresti scrivere la spec da solo, preferisci solo che lo faccia l'AI. Usa [**Explore**](add-spec-explore-mode.md) quando la stai ancora pensando e vuoi un partner che ti aiuti a darle forma.

Una spec creata in modalità Quick è una spec del tutto normale: in seguito puoi aprirla e usare **Continua a modificare** in una sessione Explore se ha bisogno di rifiniture.

## Dove andare adesso

- [Aggiungi spec — Modalità Explore](add-spec-explore-mode.md) — per le spec che hanno bisogno di essere modellate.
- [Le bozze e il Contract Layer](drafts-and-contract-layer.md) — l'arricchimento Contract Layer spiegato.
- [Esecuzione delle pipeline](running-pipelines.md) — trascina la tua nuova spec su un rail e realizzala.
