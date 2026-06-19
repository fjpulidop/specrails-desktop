# Agenti custom e il catalogo

I profili decidono *quali agenti girano e con quali modelli*. Ma da dove arrivano gli agenti stessi? Dal **catalogo degli agenti**.

Apri **Agenti → Catalogo** in qualsiasi progetto. È un visualizzatore in sola lettura di ogni agente disponibile per quel progetto, suddiviso in due gruppi:

- **Agenti upstream** — gli agenti forniti con `specrails-core`: il trio di base (`sr-architect`, `sr-developer`, `sr-reviewer`) ed eventuali specialisti come `sr-merge-resolver`.
- **Agenti custom** — gli agenti che hai aggiunto tu, con nome `custom-*`.

Ogni voce del catalogo mostra a cosa serve l'agente e il suo modello predefinito, così puoi vedere la rosa completa prima di collegare gli agenti a una catena di profilo.

## Aggiungere un agente custom

Gli agenti custom sono semplici file Markdown nel tuo repository, sotto `.claude/agents/`, con nome `custom-<qualcosa>.md`. Il file contiene le istruzioni dell'agente (il suo system prompt) e un piccolo header di frontmatter che include un `model:` predefinito.

Una volta che il file esiste nel progetto, compare nel catalogo come agente custom, e puoi aggiungere il suo id alla catena di agenti di qualsiasi profilo (e instradare i task verso di esso). L'id deve corrispondere al nome del file — una voce per `custom-docs` mappa su `.claude/agents/custom-docs.md`.

Poiché vivono nel tuo repo, gli agenti custom sono **asset di squadra committabili**: committi il file e tutta la tua squadra ottiene l'agente. Questo riflette l'idea centrale che attraversa l'intera sezione Agenti —

> **Le definizioni degli agenti sono condivise (vivono nel repo e viaggiano con `git`). La configurazione dei modelli è per progetto (vive nei profili).**

Il namespace `custom-*` è riservato e protetto: i comandi `init` e `update` di `specrails-core` non toccano mai `.claude/agents/custom-*.md`, così i tuoi agenti custom sopravvivono intatti agli aggiornamenti di core. (La stessa protezione copre i frammenti contribuiti dai plugin, come `custom-serena.md`.)

## Mettere al lavoro un agente custom

Il flusso tipico:

1. Scrivi `.claude/agents/custom-<nome>.md` con le istruzioni e un modello predefinito.
2. Verifica che compaia in **Agenti → Catalogo** sotto Custom.
3. In **Agenti → Profili**, aggiungi l'agente alla catena di un profilo (facendo eventualmente l'override del suo modello per quel profilo).
4. Aggiungi una regola di routing affinché i task con i tag giusti lo raggiungano — oppure affidati all'ordine della catena.
5. Avvia un rail con quel profilo dall'intestazione del rail.

## Tenere d'occhio le prestazioni dei profili

La sezione Agenti ha anche una scheda **Utilizzo** — una ripartizione per profilo di quanti job sono stati eseguiti con ciascun profilo in una finestra temporale selezionata. È un modo rapido per confermare che la tua suddivisione `fast`/`max` venga davvero usata come intendevi, e per individuare verso quale profilo gravita la tua squadra.

## Riepilogo dell'intera sezione

- Gli **agenti** sono i membri specializzati della squadra — il trio condiviso più gli specialisti e i tuoi agenti custom. ([Conosci gli agenti](meet-the-agents))
- I **profili** impacchettano quali agenti girano, con quali modelli e come vengono instradati i task — selezionati per ogni rail all'avvio. Il profilo default è la scelta bilanciata di tutti i giorni. ([Profili e il default bilanciato](profiles-and-the-balanced-default))
- I **modelli** vengono regolati per agente, per progetto, all'interno dei profili — costruisci `fast` e `max` per adattarti al lavoro. ([Personalizzare i modelli per agente](customizing-models-per-agent))
- **Il catalogo** mostra ogni agente, e il namespace `custom-*` ti permette di far crescere la squadra — definizioni condivise, configurazione per progetto.
