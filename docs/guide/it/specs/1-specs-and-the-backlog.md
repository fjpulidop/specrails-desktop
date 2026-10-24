# Le spec e il backlog

Una **spec** è l'unità di lavoro che la pipeline AI realizza. Puoi immaginarla come un ticket: un titolo, una descrizione di ciò che vuoi ottenere, una priorità ed eventuali etichette. Quando avvii la pipeline, gli agenti AI leggono la spec e agiscono su di essa — quindi una spec chiara è di gran lunga l'input più importante per ottenere un buon risultato.

Nell'app le spec vengono talvolta chiamate **ticket**: i due termini significano la stessa cosa.

## La board

Ogni progetto si apre sulla sua **Dashboard**, che mostra la **SpecsBoard** — l'elenco di tutte le spec del progetto. Questo è il tuo backlog. Da qui crei nuove spec, ne imposti la priorità, le trascini su un rail per realizzarle e osservi il loro stato cambiare man mano che il lavoro procede.

La board ha due modalità di visualizzazione, che si alternano con un toggle nella toolbar e vengono ricordate per ogni progetto:

- **Vista post-it** (quella predefinita) — riquadri in stile card con brevi riepiloghi.
- **Vista elenco** — righe compatte su una sola riga.

La toolbar delle Spec ha due righe. La prima contiene un campo di **ricerca** (premi `/` per raggiungerlo; cerca per titolo, `#numero`, etichetta o chiave Jira), un unico pulsante **Filtri**, i controlli di ordinamento e vista, e **Nuova spec**. La seconda riga è il **selettore di stati**: ogni stato come segmento dedicato con un conteggio in tempo reale, più due gruppi intelligenti, **Attive** (il predefinito: tutto ciò che è ancora in movimento, cioè bozze, da fare, in corso e in revisione) e **Tutti** (tutto, con Completato fissato in fondo). Quando la colonna è stretta, gli stati meno usati si raccolgono in un menu **Altro**, e lo stato scelto resta sempre visibile. La scelta viene ricordata per progetto e riflessa nell'URL, così un refresh o un link condiviso ripristina esattamente la stessa vista. **Filtri** apre un unico pannello con una sezione per dimensione: **etichette** (selezione multipla) e, nei progetti collegati a Jira, **epic**, **sprint** e **stato Jira** (gli stati *reali* del workflow della board, es. "Code Review", raggruppati sotto lo stato a cui mappano e combinati con il selettore di stati). Finché una ricerca o un filtro restringe la board, una terza riga mostra ciascuno come chip rimovibile, indica "x di y" spec e offre **Cancella tutto** (che mantiene lo stato scelto). Ordina per **Predefinito**, **Ticket #** o **Priorità**, ciascuno con un toggle crescente/decrescente.

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

Per creare una spec, clicca su **Nuova spec** (il pulsante Più nella toolbar della SpecsBoard). Si apre il dialog **Aggiungi spec**, con diversi modi di lavorare:

- **Modalità Quick** — descrivi ciò che vuoi e l'AI scrive la spec completa in un colpo solo. Vedi [Aggiungi spec — Modalità Quick](add-spec-quick-mode.md).
- **Modalità Explore** — conversi con l'AI, che ti aiuta a dare forma alla spec turno dopo turno. Vedi [Aggiungi spec — Modalità Explore](add-spec-explore-mode.md).
- **Modalità Raw** — qualunque cosa scrivi viene salvata testualmente come spec, senza alcun coinvolgimento dell'AI. Usala quando hai già pronto il testo della spec.

Quale scegliere dipende da quanto è già chiara l'idea. Sai esattamente cosa vuoi? Quick. La stai ancora mettendo a fuoco? Explore. Hai già il testo? Raw.

## Addenda: iterare su una spec esistente

Quando una spec ha già del lavoro alle spalle — una PR in revisione, una funzionalità già unita — e vuoi *di più*, non riscriverne la descrizione: snatura la spec (e sincronizza la deriva su Jira) e costringe l'esecuzione successiva a ripianificare tutto. Apri la spec e aggiungi invece un **addendum**: una breve nota con un tipo (richiesta di modifica, feedback di revisione, chiarimento, vincolo) e le tue parole. Gli addenda aperti viaggiano automaticamente con il prossimo lancio di quella spec su qualsiasi loop — Implement, SDD Quick, Freestyle — così l'esecuzione cambia solo ciò che hai chiesto, e il pacchetto di revisione riporta ciascuno come applicato, parzialmente applicato o bloccato. Se l'esecuzione fallisce o scarti la consegna, tornano da soli ad **Aperto**. L'agente di missione può aggiungerli per te quando gli chiedi di cambiare qualcosa in una spec esistente.

## Rivedere una consegna: cosa guardare per primo

Quando un'esecuzione termina, il suo pacchetto di revisione si apre con **Cosa guardare**: la breve nota del revisore IA che elenca prima i punti più rischiosi (alto, poi medio, poi basso, ciascuno con file e riga), il comportamento che cambia, le regole su cui la modifica si appoggia, i percorsi di codice che nessun test esercita e i controlli che solo una persona può fare. Gli stessi rischi, percorsi senza test e controlli compaiono in un breve blocco in cima alla pull request, e la scheda della missione mostra il rischio principale in una riga. La nota aiuta la revisione, non è un risultato di verifica: non blocca mai Accetta. Le esecuzioni fatte con uno Specrails Core precedente non hanno la nota e il loro pacchetto resta come prima.

## Dove andare adesso

- [Aggiungi spec — Modalità Quick](add-spec-quick-mode.md) — il modo più rapido per trasformare un'idea in una spec.
- [Aggiungi spec — Modalità Explore](add-spec-explore-mode.md) — dai forma a una spec conversando.
- [Le bozze e il Contract Layer](drafts-and-contract-layer.md) — salva il lavoro in corso e arricchisci le spec per la pipeline.
