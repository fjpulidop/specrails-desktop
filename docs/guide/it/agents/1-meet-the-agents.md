# Conosci gli agenti

Quando avvii un rail di tipo **Implement**, Specrails non affida la tua spec a una singola AI sperando che vada bene. Mette al lavoro una piccola squadra di *agenti* specializzati, ognuno con un compito preciso, in un ordine ben pensato. Questa pagina ti presenta chi fa parte della squadra e di cosa si occupa ciascuno.

## Il trio di base

Ogni esecuzione della pipeline usa questi tre agenti: sono la colonna portante, e un progetto non può avviare un rail senza di loro.

| Agente | Ruolo | Cosa fa |
|-------|------|--------------|
| **sr-architect** | Il pianificatore | Legge la tua spec, ispeziona il codice e produce un piano di implementazione concreto: quali file toccare, che forma assume la modifica, a cosa fare attenzione. Pensa prima che qualcuno scriva una riga di codice. |
| **sr-developer** | Il costruttore | Prende il piano dell'architect e scrive davvero il codice: nuovi file, modifiche, test. È qui che la tua spec si trasforma in un diff reale. |
| **sr-reviewer** | Il critico | Valida il lavoro del developer rispetto alla spec e al piano, intercetta le regressioni e si oppone quando qualcosa non torna. È il controllo di qualità prima che la modifica sia considerata conclusa. |

Pensalo come **progetta → costruisci → revisiona**, lo stesso ciclo che seguirebbe una squadra umana attenta. Ogni agente passa il proprio risultato al successivo, così il developer non lavora mai alla cieca e il reviewer ha sempre l'intento originale con cui fare il confronto.

## Agenti specialisti

Oltre al trio, un progetto può includere **agenti specialisti** opzionali che si occupano di tipi di lavoro specifici. Il più comune che ti capiterà di vedere è:

- **sr-merge-resolver** — un agente di utilità che aiuta a districare i conflitti di merge e a riconciliare modifiche che si sovrappongono. È opzionale: i profili lo includono solo se lo desideri, e non blocca mai la pipeline quando è assente.

Gli specialisti sono opzionali. Un progetto appena creato gira con il solo trio; aggiungi gli specialisti (e i tuoi **agenti custom** — vedi [Agenti custom e il catalogo](custom-agents-catalog)) quando il flusso di lavoro di un progetto lo richiede.

## Come i task raggiungono l'agente giusto

All'interno di un'esecuzione, il lavoro viene *instradato*. Un task porta con sé dei tag, e le regole di routing di un profilo inviano i task taggati all'agente più adatto a gestirli — con una regola finale "cattura-tutto" che manda tutto il resto al developer. Per l'uso normale non devi preoccupartene: la configurazione predefinita instrada ogni cosa in modo sensato già di default. Quando vorrai indirizzare tipi di lavoro specifici verso agenti specifici, dai un'occhiata a [Personalizzare i modelli per agente](customizing-models-per-agent).

## Un'idea importante, da subito

La *definizione* di ciascun agente — le sue istruzioni, la sua personalità, ciò che gli è consentito fare — è **condivisa**. Queste definizioni vivono come file (`.claude/agents/<id>.md`) che viaggiano insieme al tuo repository, così tutta la tua squadra usa lo stesso architect, lo stesso reviewer.

Ciò che invece è **per progetto** è la *configurazione* che ci sta sopra: con quale modello gira ciascun agente e quale combinazione di agenti scegli per un dato rail. È a questo che servono i profili — ed è proprio l'argomento della prossima pagina.

## Dove andare adesso

- [Profili e il default bilanciato](profiles-and-the-balanced-default) — come la configurazione della squadra viene impacchettata e selezionata.
- [Personalizzare i modelli per agente](customizing-models-per-agent) — bilancia costo e qualità.
