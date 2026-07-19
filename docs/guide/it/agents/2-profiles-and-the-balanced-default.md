# Profili e il default bilanciato

Un **profilo** è una ricetta salvata per un'esecuzione della pipeline. Risponde a tre domande in un unico posto:

1. **Quali agenti** partecipano (il trio di base, più eventuali specialisti o agenti custom).
2. **Con quale modello** gira ciascun agente.
3. **Come vengono instradati** i task verso quegli agenti.

Trovi i profili nella sezione **Agenti** di qualsiasi progetto (barra laterale destra → **Agenti** → scheda **Profili**).

## Il default bilanciato

Fin da subito, un progetto si risolve verso un sensato profilo **default**. Include il trio di base — `sr-architect`, `sr-developer`, `sr-reviewer` — e instrada ogni task al developer tramite un'unica regola "cattura-tutto". I modelli sono bilanciati per il lavoro di tutti i giorni: un modello capace dove conta, senza ricorrere all'opzione più costosa a ogni passaggio.

Se nel tuo progetto i modelli degli agenti erano già configurati alla vecchia maniera (nel frontmatter dei file agente), il pulsante **Migra** li legge e costruisce un profilo `default` che rispecchia esattamente il comportamento attuale — nessuna perdita, niente cambia finché non decidi tu di metterci mano.

Il punto chiave: **non sei obbligato a creare un profilo per usare Specrails.** Il default funziona e basta. I profili sono il modo per andare oltre.

## Come viene scelto un profilo per un'esecuzione

Quando avvii un rail, Specrails sceglie un profilo in questo ordine:

1. La tua **scelta esplicita** nell'intestazione del rail (vedi sotto).
2. La tua **preferenza per sviluppatore** — un profilo che hai contrassegnato come tuo default personale per questo progetto (è locale a te e non viene committato).
3. Il profilo **`default`** del progetto.

Il profilo viene *fotografato in uno snapshot all'avvio*, così ogni rail di un batch può girare con un profilo diverso, e modificare un profilo in seguito non riscrive mai i job che sono già partiti.

## Selezionare un profilo per ogni rail

La scelta del profilo avviene proprio dove si lancia — nell'**intestazione del rail**, tramite il selettore di profilo.

- Scegli un profilo dal menu a discesa per usarlo **solo per questo avvio**.
- Usa l'opzione di persistenza per rendere un profilo la scelta stabile del rail da qui in avanti.

È tutto il flusso: scegli un profilo, avvia, fatto. I rail concorrenti nello stesso batch possono portare ciascuno il proprio profilo, così una correzione veloce e una feature impegnativa possono girare fianco a fianco con configurazioni diverse.

## Quando la sezione Agenti tace

I profili sono separati per provider. Claude e Kimi supportano profili/ruoli;
Codex e Gemini usano la modalità legacy. In progetti misti lo stesso nome non
attraversa Claude/Kimi. Kimi consente ruoli manuali, ma generazione, smoke test
e AI Refine di Agent Studio sono rifiutati prima dello spawn. Kimi richiede
`specrails-core` 4.12.0 o più recente.

## Dove andare adesso

- [Personalizzare i modelli per agente](customizing-models-per-agent) — costruisci i profili `fast` e `max`.
- [Agenti custom e il catalogo](custom-agents-catalog) — vedi ed estendi la squadra.
