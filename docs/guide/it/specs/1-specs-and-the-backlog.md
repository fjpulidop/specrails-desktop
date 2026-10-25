# Le spec e il backlog {#specs-backlog}

Una **spec** è l'unità di lavoro che la pipeline AI realizza. Puoi immaginarla come un ticket: un titolo, una descrizione di ciò che vuoi ottenere, una priorità ed eventuali etichette. Quando avvii la pipeline, gli agenti AI leggono la spec e agiscono su di essa — quindi una spec chiara è di gran lunga l'input più importante per ottenere un buon risultato.

Nell'app le spec vengono talvolta chiamate **ticket**: i due termini significano la stessa cosa.

## La board

Ogni progetto si apre sulla sua **Dashboard**, che mostra la **SpecsBoard** — l'elenco di tutte le spec del progetto. Questo è il tuo backlog. Da qui crei nuove spec, ne imposti la priorità, le trascini su un rail per realizzarle e osservi il loro stato cambiare man mano che il lavoro procede.

La board ha due modalità di visualizzazione, che si alternano con un toggle nella toolbar e vengono ricordate per ogni progetto:

- **Vista post-it** (quella predefinita) — riquadri in stile card con brevi riepiloghi.
- **Vista elenco** — righe compatte su una sola riga.

La toolbar delle Spec ha due righe. La prima contiene un campo di **ricerca** (premi `/` per raggiungerlo; cerca per titolo, `#numero`, etichetta o chiave Jira), un unico pulsante **Filtri**, i controlli di ordinamento e vista, e **Nuova spec**. La seconda riga è il **selettore di stati**: ogni stato come segmento dedicato con un conteggio in tempo reale, più due gruppi intelligenti, **Attive** (il predefinito: tutto ciò che è ancora in movimento, cioè bozze, da fare, in corso e in revisione) e **Tutti** (tutto, con Completato fissato in fondo). Quando la colonna è stretta, gli stati meno usati si raccolgono in un menu **Altro**, e lo stato scelto resta sempre visibile. La scelta viene ricordata per progetto e riflessa nell'URL, così un refresh o un link condiviso ripristina esattamente la stessa vista. **Filtri** apre un unico pannello con una sezione per dimensione: **etichette** (selezione multipla) e, nei progetti collegati a Jira, **epic**, **sprint** e **stato Jira** (gli stati *reali* del workflow della board, es. "Code Review", raggruppati sotto lo stato a cui mappano e combinati con il selettore di stati). Finché una ricerca o un filtro restringe la board, una terza riga mostra ciascuno come chip rimovibile, indica "x di y" spec e offre **Cancella tutto** (che mantiene lo stato scelto). Ordina per **Predefinito**, **Ticket #** o **Priorità**, ciascuno con un toggle crescente/decrescente.

### Selezionare più spec

Fai la triage in blocco invece di una spec alla volta. Premi `x` su una scheda a fuoco, fai clic su una scheda con `Ctrl`/`⌘`, oppure fai clic con `Maiusc` per selezionare un intervallo (un intervallo resta dentro una colonna: le spec attive o il gruppo Completate). `Ctrl`/`⌘`+`A` seleziona l'intera colonna in cui ti trovi e `Esc` deseleziona tutto. Ogni scheda mostra una casella al passaggio del mouse o quando ha il fuoco, e quelle selezionate hanno il bordo evidenziato. Nessuno di questi tasti agisce mentre scrivi nel campo di ricerca.

Appena una spec è selezionata, in basso nella board compare una barra mobile con il conteggio e le azioni:

- **Sposta in** cambia lo stato. Le spec locali ricevono gli stati locali; quelle che arrivano da Jira ricevono i veri stati del workflow della board Jira e passano dalla stessa coda Jira di uno spostamento singolo.
- **Etichetta** aggiunge un'etichetta alla selezione, oppure ne rimuove una presente nelle spec.
- **Priorità** imposta la stessa priorità per tutte.
- **Aggiungi a un rail** mette la selezione su un rail.
- **Avvia tutto** assegna a ogni spec selezionata un rail libero tutto suo e le avvia in parallelo, dopo la stessa conferma e lo stesso controllo del budget giornaliero di *Avvia tutto* dei rail. Le spec che non possono ancora partire (per esempio in revisione senza PR aperta) o che non trovano un rail libero vengono saltate e contate nel riepilogo.
- **Elimina** le sposta in *Eliminate di recente*.
- **Deseleziona** (o `Esc`) scarta la selezione.

Eliminazione e modifiche di stato, etichette o priorità si annullano in un solo passaggio: un unico avviso *Annulla* (o `⌘Z`) ripristina ogni spec modificata. Se alcune falliscono, un solo avviso indica quante sono riuscite e quante no. La selezione contiene solo spec visibili: un filtro che nasconde una spec selezionata la toglie dalla selezione.

### Viste salvate

Il pulsante **Viste**, accanto a **Filtri**, salva la board così com'è ora: il selettore di stato, i filtri, l'ordinamento e la densità (non il testo di ricerca). Scegli **Salva la vista attuale…**, dalle un nome («Pronte da avviare», «Sprint 42», «Fallite questa settimana») e scegliila poi dallo stesso menu. **Gestisci le viste…** rinomina una vista, la aggiorna con la board attuale, ne copia il link o la elimina. Le viste appartengono al progetto. Un link copiato (`?view=…`) applica la vista quando viene aperto in questa app, e la palette dei comandi (`⌘K`) può salvare la vista attuale o passare a un'altra.

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

## Annulla e Eliminati di recente {#recently-deleted}

Eliminare una spec, spostarla in un altro stato, cambiarne le etichette o toglierla da un rail avviene subito: nessun "Sei sicuro?" prima. Al suo posto, una notifica offre **Annulla** per circa otto secondi, e **⌘Z** (**Ctrl+Z** su Windows e Linux) fa lo stesso finché non stai scrivendo in un campo. Annulla vale per progetto: cambiando progetto la finestra si chiude.

Una spec eliminata (e una missione eliminata) non sparisce. Va in **Impostazioni → Eliminati di recente**, nelle impostazioni del progetto, dove puoi **Ripristinarla** per 30 giorni o **Eliminarla definitivamente**, che chiede prima conferma. Dopo 30 giorni viene rimossa per sempre. Scartare lavoro non pushato, chiudere con la forza una pull request e rimuovere un progetto chiedono ancora conferma, perché non si possono annullare. Una spec collegata a Jira si sposta ancora con **Sposta in** invece di essere eliminata.

## Dove andare adesso

- [Aggiungi spec — Modalità Quick](add-spec-quick-mode.md) — il modo più rapido per trasformare un'idea in una spec.
- [Aggiungi spec — Modalità Explore](add-spec-explore-mode.md) — dai forma a una spec conversando.
- [Le bozze e il Contract Layer](drafts-and-contract-layer.md) — salva il lavoro in corso e arricchisci le spec per la pipeline.
