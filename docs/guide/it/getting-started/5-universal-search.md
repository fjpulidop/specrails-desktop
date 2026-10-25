# Ricerca universale (⌘K)

Premi **⌘K** (**Ctrl+K** su Windows e Linux) per cercare quasi tutto in Specrails da un solo posto: missioni, specs, log dei job, file, impostazioni e questa guida. Scrivi una ricerca normale per cercare tra missioni, progetti, specs e job recenti come prima, oppure inizia con un **prefisso** per cercare in una sola fonte.

## Prefissi

| Scrivi | Cerca | Invio apre |
| --- | --- | --- |
| `#` | Specs: titolo, riepilogo, descrizione, etichette, note fuori ambito, addendum e commenti. `#12` trova la spec 12. | La spec |
| `@` | Missioni: titolo e contenuto della conversazione. | La missione |
| `/` | Impostazioni (di Desktop e del progetto) per nome o per come le chiameresti. | La finestra delle impostazioni su quel blocco, visibile e con il focus |
| `f:` | File del progetto, per nome o percorso. | Il file nell’esplora codice |
| `log:` | Log dei job: comandi, nomi dei loop, titoli delle fasi e diagnosi degli errori. | Il job |
| `?` | Questa guida: titoli delle pagine e intestazioni. | La guida su quell’intestazione |

Quando scrivi un prefisso diventa un **chip** nella casella di ricerca e la casella conserva solo la tua ricerca. Premi **Backspace** a casella vuota (o clicca la × del chip) per togliere l’ambito. A casella vuota la palette elenca i prefissi sotto la casella; clicca su uno per iniziare. `>` continua a elencare le azioni, come prima.

## Evidenziazione

I risultati mostrano un breve estratto attorno alla prima corrispondenza, con il testo trovato evidenziato. La ricerca ignora maiuscole e accenti, quindi `revision` trova «Révision».

## Impostazioni

`/` conosce i principali blocchi di impostazioni, nella tua lingua: tema, lingua, editor, budget, notifiche, webhook, aggiornamenti, branch, ambiente, telemetria, regole e altro. Le impostazioni del progetto vengono proposte quando un progetto è aperto. Sceglierne una apre la finestra giusta su quel blocco. Senza prefisso, una corrispondenza forte (tre o più caratteri) aggiunge fino a tre impostazioni ai risultati normali.

## Log dei job

`log:` cerca in un indice compatto, non nell’output grezzo di un’esecuzione: il comando, il nome del loop, i titoli delle fasi e la breve diagnosi di un’esecuzione fallita, bloccata o ferma. Non memorizza mai flussi di token né output degli strumenti, quindi resta piccolo e veloce. È tenuto per progetto e contiene le esecuzioni più recenti.

## Da sapere

- `#`, `f:` e `log:` cercano nel progetto attivo; apri prima un progetto.
- L’ambito dei file rispetta le regole di esclusione dell’esplora codice.
- Ogni gruppo mostra solo i risultati migliori; affina la ricerca per restringere.
