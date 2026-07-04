# Le spec e il backlog

Una **spec** è l'unità di lavoro che la pipeline AI realizza. Puoi immaginarla come un ticket: un titolo, una descrizione di ciò che vuoi ottenere, una priorità ed eventuali etichette. Quando avvii la pipeline, gli agenti AI leggono la spec e agiscono su di essa — quindi una spec chiara è di gran lunga l'input più importante per ottenere un buon risultato.

Nell'app le spec vengono talvolta chiamate **ticket**: i due termini significano la stessa cosa.

## La board

Ogni progetto si apre sulla sua **Dashboard**, che mostra la **SpecsBoard** — l'elenco di tutte le spec del progetto. Questo è il tuo backlog. Da qui crei nuove spec, ne imposti la priorità, le trascini su un rail per realizzarle e osservi il loro stato cambiare man mano che il lavoro procede.

La board ha due modalità di visualizzazione, che si alternano con un toggle nella toolbar e vengono ricordate per ogni progetto:

- **Vista post-it** (quella predefinita) — riquadri in stile card con brevi riepiloghi.
- **Vista elenco** — righe compatte su una sola riga.

Il **selettore di stati** della toolbar mostra ogni stato come chip dedicato con un conteggio in tempo reale — più due gruppi intelligenti: **Attive** (il predefinito — tutto ciò che è ancora in movimento: bozze, da fare, in corso e in revisione) e **Tutti** (tutto, con Completato fissato in fondo). La scelta viene ricordata per progetto e riflessa nell'URL, così un refresh o un link condiviso ripristina esattamente la stessa vista. Nei progetti collegati a Jira compare in più un menu a tendina **stato Jira**, che elenca gli stati *reali* del workflow della board (i nomi grezzi, es. "Code Review", ciascuno con il proprio conteggio in tempo reale) raggruppati sotto lo stato a cui mappano — si combina con i chip di stato. Puoi anche filtrare per **etichetta**, oltre a ordinare per **Predefinito**, **Ticket #** o **Priorità** (ciascuno con un toggle crescente/decrescente).

## Stati

Una spec attraversa un piccolo insieme di stati. La board associa a ciascuno un segnale visivo coerente, così puoi leggere lo stato del tuo backlog a colpo d'occhio:

| Stato | Cosa significa |
|--------|---------------|
| **Bozza** | Un'idea in corso salvata da una conversazione in modalità Explore. Non ancora pronta da realizzare — puoi tornarci e continuare a darle forma. Mostra un badge `Draft`. |
| **Da fare** | Pronta per essere presa in carico. È qui che atterra una spec finita quando la crei. |
| **In corso** | La pipeline ci sta lavorando in questo momento (un punto blu pulsante). |
| **In revisione** | Implementata — ogni esecuzione conclusa parcheggia qui le sue spec per la tua approvazione: fai il merge della PR in bozza o spostale tu stesso (un badge ambra). |
| **Completato** | Approvata — la sua PR è stata unita, o l'hai spostata qui tu stesso (un segno di spunta verde). |
| **Annullato** | Abbandonata (una X rossa). |

Le bozze vivono nello stesso gruppo attivo delle spec Da fare — non c'è una colonna separata per loro — ma hanno un bordo dalla tinta sottile e un badge `Draft` che le rende facili da individuare. Consulta [Le bozze e il Contract Layer](drafts-and-contract-layer.md) per tutta la storia sulle bozze.

## Priorità

Ogni spec non-bozza ha una priorità: **Critica**, **Alta**, **Media** o **Bassa**. La priorità è puramente uno strumento organizzativo — ti aiuta a decidere cosa realizzare per primo e ti permette di ordinare la board. La imposti quando crei una spec e puoi cambiarla in qualsiasi momento facendo clic con il tasto destro sulla card della spec e scegliendo **Imposta priorità**.

Le bozze sono l'unica eccezione: una bozza può non avere *alcuna* priorità, perché è ancora un'idea in lavorazione. La priorità viene fissata quando confermi la bozza trasformandola in una spec vera e propria.

## Creare una spec

Per creare una spec, clicca su **Aggiungi** (il pulsante Più nella toolbar della SpecsBoard). Si apre il dialog **Aggiungi spec**, con diversi modi di lavorare:

- **Modalità Quick** — descrivi ciò che vuoi e l'AI scrive la spec completa in un colpo solo. Vedi [Aggiungi spec — Modalità Quick](add-spec-quick-mode.md).
- **Modalità Explore** — conversi con l'AI, che ti aiuta a dare forma alla spec turno dopo turno. Vedi [Aggiungi spec — Modalità Explore](add-spec-explore-mode.md).
- **Modalità Raw** — qualunque cosa scrivi viene salvata testualmente come spec, senza alcun coinvolgimento dell'AI. Usala quando hai già pronto il testo della spec.

Quale scegliere dipende da quanto è già chiara l'idea. Sai esattamente cosa vuoi? Quick. La stai ancora mettendo a fuoco? Explore. Hai già il testo? Raw.

## Dove andare adesso

- [Aggiungi spec — Modalità Quick](add-spec-quick-mode.md) — il modo più rapido per trasformare un'idea in una spec.
- [Aggiungi spec — Modalità Explore](add-spec-explore-mode.md) — dai forma a una spec conversando.
- [Le bozze e il Contract Layer](drafts-and-contract-layer.md) — salva il lavoro in corso e arricchisci le spec per la pipeline.
