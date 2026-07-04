# Code explorer

La sezione **Code** ti offre una finestra amichevole e in sola lettura sul tuo repository — pensata in particolare per chi vuole capire cosa ha costruito l'AI senza dover vivere in un editor. Hai un albero dei file a sinistra, un visualizzatore di codice a destra e, sopra il codice, un riepilogo in linguaggio semplice di cosa fa davvero ogni file.

In questa versione è rigorosamente in sola lettura: nulla di ciò che fai qui modifica i tuoi file. Pensala come una sala di lettura, non un'officina.

Aprila dalla barra laterale destra (**Code**) e, come tutto il resto, è circoscritta al progetto corrente.

## L'albero dei file

Il riquadro di sinistra è un albero virtualizzato dei file del tuo progetto — veloce anche su repo di grandi dimensioni. Rispetta il tuo `.gitignore` e una deny-list integrata, così vedi i file che contano, non un mare di artefatti di build e `node_modules`.

Accanto ai file noterai dei **marcatori di provenienza** — piccoli indicatori che ti dicono che un file è stato *toccato dall'AI*. È questo il cuore del Code explorer: Specrails registra quali file ogni job della pipeline ha creato o modificato, e li ricollega al ticket che ha avviato il lavoro. Così puoi rispondere, a colpo d'occhio, a "l'ha scritto l'AI, o l'ho fatto io?".

In cima all'albero c'è un filtro:

- **Toccati dall'AI** (predefinito) — solo i file che l'AI ha modificato.
- **Tutti i file** — l'albero completo.

La tua scelta viene ricordata per progetto, così se ti interessano soprattutto le modifiche scritte dall'AI le vedrai per prime ogni volta.

## Il visualizzatore di codice

Clicca un file e si apre in un visualizzatore completo (basato su Monaco, lo stesso motore di VS Code) con un'evidenziazione della sintassi adeguata che si abbina al tema dell'app che hai scelto. Un paio di limiti ragionevoli mantengono tutto fluido: i file binari vengono educatamente rifiutati e i file molto grandi (oltre 2 MB) non vengono caricati.

Il file corrente viene salvato nell'URL della pagina, così puoi aggiungere ai segnalibri o condividere un link diretto a un file specifico.

Poiché la modifica non fa parte di questa versione, il visualizzatore offre un pulsante **Modifica in un editor esterno** che copia il percorso assoluto del file — incollalo nell'editor che preferisci e riparti da lì.

## Riepiloghi AI

Sopra il codice vedrai un **riepilogo in linguaggio semplice** del file — a cosa serve, cosa fa — scritto in modo che anche chi non è uno sviluppatore possa seguirlo. Vengono generati per te e messi in cache, così aprire un file che hai già guardato è istantaneo.

I riepiloghi sono attenti a restare aggiornati: sono legati al contenuto del file, così quando un file cambia davvero il riepilogo viene rigenerato, mentre i file invariati non vengono ri-riassunti inutilmente. Se modifichi tu stesso un file, il suo riepilogo viene contrassegnato come obsoleto anziché rigenerato in silenzio — resti tu a decidere quando aggiornarlo. C'è un'azione di **rigenerazione** per quando vuoi una nuova versione a richiesta.

Un paio di garanzie tengono i costi ragionevoli: la generazione dei riepiloghi avviene entro un **budget mensile** (qualche dollaro per impostazione predefinita, configurabile nelle Impostazioni), e ci sono limiti su quanti riepiloghi un singolo job può avviare. Se un riepilogo viene saltato, l'app ti dice perché — budget raggiunto, un limite per job, o semplicemente il file non trovato.

Puoi anche scegliere la **lingua dei riepiloghi** (inglese o spagnolo) nelle impostazioni globali, nell'area *Code section*.

## La storia di costruzione

Sotto il visualizzatore di codice vive la **storia di costruzione**: una linea temporale cronologica di ogni spec e di ogni job che hanno costruito il file che stai guardando. Ogni capitolo è una scheda: quale spec è intervenuta (con il suo stato attuale), quando, se il file è stato creato, modificato o eliminato, e quanto è stato grande il cambiamento (righe aggiunte e rimosse). Fai clic su una scheda per aprire il dettaglio di quella spec. Anche i rail basati sui loop registrano i file che toccano, quindi il lavoro svolto in worktree isolati compare nella storia come i normali job della pipeline.

Per qualsiasi capitolo puoi chiedere una spiegazione in linguaggio semplice: premi **Spiega questa modifica** e l'app scrive da una a tre frasi che descrivono cosa quel cambiamento specifico ha apportato al file — senza codice, senza gergo. Le spiegazioni condividono lo stesso budget mensile dei riepiloghi dei file e, finché non ne viene generata una, la scheda si affida ai fatti che conosce: il tipo di modifica, la spec e la data. Preferisci i dati grezzi? Un selettore **Storia / Registro** passa alla classica lista delle modifiche con diff su richiesta. Lo stesso pannello compare nella vista **Files** della modalità Agente.

## Collegare il codice alle spec

Il legame di provenienza funziona in entrambe le direzioni. All'interno del Code explorer, cliccare il chip di un ticket su un file apre il dettaglio di quel ticket. E dall'altro lato, la vista di **dettaglio del ticket** ha una sezione *File toccati da questo ticket* — clicca un file lì e salti dritto nel Code explorer con quel file aperto. Chiude il cerchio tra "ecco la spec che abbiamo scritto" ed "ecco il codice che ne è uscito".

## Cosa non fa (ancora)

Per fissare le aspettative con chiarezza, questa prima versione lascia di proposito fuori alcune cose: la modifica all'interno dell'app, i riepiloghi per simbolo o a livello di directory, una vista diff narrativa e il "chiedi all'AI di questo file" in forma conversazionale. La provenienza attribuisce un file solo al suo ticket principale. Sono il genere di cose che potrebbero crescere nel tempo.

## Disattivarlo

Il Code explorer è attivo per impostazione predefinita. Può essere disabilitato con i flag `VITE_FEATURE_CODE_EXPLORER` (client) o `SPECRAILS_CODE_EXPLORER` (server) — imposta uno dei due su `false`. Disattivarlo lascia tutti i tuoi dati registrati e i riepiloghi al sicuro su disco, intatti, nel caso tu voglia riattivarlo.
