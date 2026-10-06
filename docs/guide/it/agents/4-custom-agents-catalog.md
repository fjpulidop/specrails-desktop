# Agenti custom e il catalogo

I profili decidono *quali agenti girano e con quali modelli*. Ma da dove arrivano gli agenti stessi? Dal **catalogo degli agenti**.

Apri **Agenti → Catalogo** in qualsiasi progetto. È un visualizzatore in sola lettura di ogni agente disponibile per quel progetto, suddiviso in due gruppi:

- **Agenti upstream** — i ruoli che l'engine Core definisce a runtime: il trio di base (`sr-architect`, `sr-developer`, `sr-reviewer`). Non sono file nel tuo repo; il catalogo mostra in sola lettura la definizione attiva di ogni ruolo, e la modifichi in **Impostazioni → Motore degli agenti**.
- **Agenti custom** — gli agenti che hai aggiunto tu, con nome `custom-*`.

Ogni voce del catalogo mostra a cosa serve l'agente; gli agenti personalizzati mostrano anche il loro modello predefinito, mentre i ruoli di base girano con il provider e il modello impostati in **Impostazioni → Motore degli agenti**. In ogni caso puoi vedere la rosa completa prima di collegare gli agenti a una catena di profilo.

## Aggiungere un agente custom

Poiché vivono nel tuo repo, gli agenti custom sono **asset di squadra committabili**: committi il file e tutta la tua squadra ottiene l'agente. Questo riflette l'idea centrale che attraversa l'intera sezione Agenti —

> **Le definizioni degli agenti personalizzati sono condivise (vivono nel repo e viaggiano con `git`); i ruoli di base li definisce il runtime di Core. La configurazione dei modelli è per progetto (vive nei profili).**

## Mettere al lavoro un agente custom

Il flusso tipico:

## Tenere d'occhio le prestazioni dei profili

La sezione Agenti ha anche una scheda **Utilizzo** — una ripartizione per profilo di quanti job sono stati eseguiti con ciascun profilo in una finestra temporale selezionata. È un modo rapido per confermare che la tua suddivisione `fast`/`max` venga davvero usata come intendevi, e per individuare verso quale profilo gravita la tua squadra.

## Riepilogo dell'intera sezione

- Gli **agenti** sono i membri specializzati della squadra — il trio condiviso più gli specialisti e i tuoi agenti custom. ([Conosci gli agenti](meet-the-agents))
- I **profili** impacchettano quali agenti girano, con quali modelli e come vengono instradati i task — selezionati per ogni rail all'avvio. Il profilo default è la scelta bilanciata di tutti i giorni. ([Profili e il default bilanciato](profiles-and-the-balanced-default))
- I **modelli** vengono regolati per agente, per progetto, all'interno dei profili — costruisci `fast` e `max` per adattarti al lavoro. ([Personalizzare i modelli per agente](customizing-models-per-agent))
- **Il catalogo** mostra ogni agente, e il namespace `custom-*` ti permette di far crescere la squadra — definizioni condivise, configurazione per progetto.
