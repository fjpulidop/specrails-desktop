# Ricerca universale (⌘K)

Premi **⌘K** (**Ctrl+K** su Windows e Linux) per cercare quasi tutto in Specrails da un solo posto: missioni, specs, log dei job, file, impostazioni e questa guida. Scrivi una ricerca normale per cercare tra missioni, progetti, specs e job recenti come prima, oppure inizia con un **prefisso** per cercare in una sola fonte.

## Riprendi

Con la casella vuota, il primo gruppo è **Riprendi**: le missioni e i job attivi più di recente, dal più recente, con il più recente del progetto aperto in testa, così **Invio** ti lascia dove sei. Ogni riga mostra la spia del suo stato e il nome del progetto quando non è quello aperto. Quando qualcosa ha bisogno di te, una riga in cima dice quante cose (**3 cose ti aspettano**) e apre la casella, l'unico elenco di ciò che ti aspetta; gli elementi della casella non sono elencati qui.

Premi da **⌘1** a **⌘6** (da **Ctrl+1** a **Ctrl+6** su Windows e Linux) per aprire direttamente una riga di missione o di job (la riga della casella non ha numero), oppure scegli una riga con le frecce e **Invio**. Una riga si apre esattamente come altrove: una missione apre la missione, un job apre il job. Finché la palette è aperta questi tasti sono suoi: le scorciatoie di pagina (⌘1–5) e il cambio di progetto (⌥⌘1–9) aspettano che si chiuda. L'ordine resta fisso finché la palette è aperta, così nessuna riga si sposta sotto le dita; gli stati si aggiornano comunque e la lista viene riordinata alla prossima apertura. Le righe di questo gruppo non si ripetono in Missioni o Job.

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

`/` conosce i principali blocchi di impostazioni, nella tua lingua: tema, lingua, editor, budget, notifiche, webhook, aggiornamenti, branch, ambiente, telemetria, regole e altro. Le impostazioni del progetto vengono proposte quando un progetto è aperto. Sceglierne una apre la finestra giusta su quel blocco. Senza prefisso, una corrispondenza forte (tre o più caratteri) aggiunge fino a tre impostazioni ai risultati normali. `/budget` trova anche il pannello Budget (limiti, proiezione, e se…), dove si trovano i limiti settimanale e mensile. Un comando con barra come `/implement` compare sotto le impostazioni, in un gruppo a parte, quindi il prefisso `/` non lo nasconde mai.

## Log dei job

`log:` cerca in un indice compatto, non nell’output grezzo di un’esecuzione: il comando, il nome del loop, i titoli delle fasi e la breve diagnosi di un’esecuzione fallita, bloccata o ferma. Non memorizza mai flussi di token né output degli strumenti, quindi resta piccolo e veloce. È tenuto per progetto e contiene le esecuzioni più recenti.

## Da sapere

- `#`, `f:` e `log:` cercano nel progetto attivo; apri prima un progetto.
- L’ambito dei file rispetta le regole di esclusione dell’esplora codice.
- Ogni gruppo mostra solo i risultati migliori; affina la ricerca per restringere.
