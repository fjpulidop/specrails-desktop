# Cos'è specrails

Benvenuto in **specrails** — un'app desktop che trasforma un assistente AI per la programmazione in un vero team di sviluppo, al lavoro sui *tuoi* progetti, sulla *tua* macchina.

Invece di copiare e incollare prompt avanti e indietro, descrivi ciò che vuoi sotto forma di **spec**, e specrails la fa scorrere attraverso un'intera pipeline di sviluppo — progettando, costruendo, revisionando e consegnando la modifica — mentre tu la guardi accadere in tempo reale.

## Sviluppo AI guidato dalle spec

Il cuore di specrails è un'idea semplice: **il modo migliore per ottenere buon codice dall'AI è partire da una spec chiara.**

Una *spec* è una descrizione breve e strutturata di un singolo intervento — una funzionalità, una correzione, un refactor. Puoi scriverne una in pochi secondi, oppure darle forma attraverso una chat guidata che ti pone le domande giuste e la redige al posto tuo. Ogni spec diventa un **ticket** sulla board del tuo progetto, proprio come un'attività in un qualsiasi issue tracker.

Da lì, affidi la spec alla pipeline e lasci che sia l'AI a fare il lavoro pesante.

## La pipeline: Architect → Developer → Reviewer → Ship

Quando avvii una spec, specrails la fa passare attraverso quattro fasi, ciascuna interpretata da un agente AI specializzato:

1. **Architect** — legge la tua spec e il codice circostante, poi pianifica la modifica: quali file toccare, quale forma dovrebbe avere la soluzione.
2. **Developer** — scrive il codice vero e proprio, seguendo il piano.
3. **Reviewer** — controlla il lavoro per correttezza e qualità, intercettando i problemi prima che lo faccia tu.
4. **Ship** — finalizza la modifica così che sia pronta per il commit.

Vedi ogni fase mentre viene eseguita, con i log in tempo reale che arrivano direttamente dall'AI. Niente è nascosto — se qualcosa va storto, vedrai esattamente dove.

## Progetti

Tutto in specrails è organizzato intorno ai **progetti**. Un progetto è semplicemente una cartella sul tuo computer che contiene un codebase. Puoi aggiungere tutti i progetti che vuoi e passare dall'uno all'altro all'istante — ognuno conserva le proprie spec, la cronologia dei job, le analytics e le impostazioni.

Specrails non tocca mai codice che non gli hai chiesto di toccare. Lavora all'interno del tuo repository esistente e sei tu a mantenere il controllo su cosa viene committato.

## Scegli il tuo provider AI

Specrails funziona con le principali CLI di programmazione AI:

- **Claude** (Claude Code)
- **Codex** (Codex CLI)
- **Gemini** (Gemini CLI)

Scegli quella che già usi — oppure installane più di una e scegline una a seconda dell'attività. Un progetto può funzionare con un singolo provider o con più provider contemporaneamente, così non resti mai vincolato a una scelta.

## Perché ti piacerà

- **Velocità senza caos** — le spec mantengono l'AI concentrata, così ottieni modifiche utili invece di tentativi dispersivi.
- **Piena visibilità** — log in tempo reale, una vista chiara della pipeline e analytics per progetto ti mostrano esattamente cosa è successo e quanto è costato.
- **La tua macchina, il tuo codice** — tutto gira in locale sul tuo repository reale.
- **Un unico posto per tutto** — spec, job, chat, un terminale integrato e il monitoraggio dei costi, tutto in un'unica finestra.

Pronto a partire? Prossima tappa: [Installazione e primo avvio](installing-and-first-run).
