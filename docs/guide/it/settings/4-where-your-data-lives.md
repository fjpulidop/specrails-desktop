# Dove vivono i tuoi dati

In breve: **Specrails mantiene i tuoi repository immacolati.** Quando punti l'app a uno dei tuoi progetti, non ci si insedia, non sparpaglia file di configurazione in giro e non riscrive nulla che non gli abbia chiesto. Il tuo codice resta tuo, e pulito.

## Il tuo repo resta pulito

I file di Specrails — i suoi database, lo stato per progetto, le definizioni degli agent, le impostazioni, la telemetria, i riassunti e tutto il resto che gli serve per funzionare — vivono in un'unica casa ordinata sotto la tua home directory:

```
~/.specrails/
```

**Impostazioni ▸ Informazioni** mostra la posizione esatta del database e la versione dell'app che stai usando.

Quella cartella è il workspace privato dell'app. È dove vivono il registro dei progetti, i database per progetto, gli strumenti integrati e tutte le parti operative. I tuoi repository di codice veri e propri non vengono mai usati come discarica per nulla di tutto ciò.

Questo significa che:

- Il `.gitignore` del tuo repo **non** viene riscritto dall'app.
- Il tuo repo non viene riempito di configurazioni di strumenti o directory di stato nascoste.
- Rimuovere un progetto da Specrails non lascia disordine nel tuo codice.

Se in passato hai usato strumenti che aggiungevano silenziosamente cartelle e file in giro per il tuo progetto, qui si tratta di una scelta deliberatamente diversa. Specrails è costruito in modo che puntarlo a un repo sia un **non-evento** per la storia git di quel repo.

## L'unica cosa che *viene* committata — di proposito

C'è esattamente un'eccezione voluta, ed è il senso stesso dello strumento: **le tue spec OpenSpec.**

Le spec vivono nel tuo repository, sotto:

```
openspec/
```

E questo è voluto. Le tue spec sono un **deliverable** — un resoconto versionato e revisionabile di cosa hai deciso di costruire e perché. Devono stare accanto al tuo codice, tracciate in git, visibili nelle pull request, condivise con il tuo team. È lì il valore: le spec non sono stato temporaneo da buttare via, sono parte della storia del tuo progetto.

Quindi la regola è semplice e onesta:

- **`openspec/`** → vive nel tuo repo, committata, di proposito.
- **Tutto il resto di cui Specrails ha bisogno** → vive sotto `~/.specrails/`, fuori dai piedi.

## Perché funziona così

Specrails esegue gli strumenti AI dal proprio workspace privato (sotto `~/.specrails/`) e raggiunge il tuo repository reale solo per le cose che hanno davvero bisogno di toccarlo — leggere il tuo codice e scrivere le spec che hai richiesto. Gli strumenti, le definizioni del framework e tutta la contabilità restano nella cartella di casa dell'app.

Il vantaggio per te: puoi aggiungere un progetto, eseguire pipeline, esplorare spec e fare esperimenti con la certezza che il working tree e la storia git del tuo repository cambino solo nei modi che ti aspetteresti — le tue spec committate e il codice che le tue pipeline scrivono. Nient'altro si intrufola.

## Rimuovere un progetto

Quando rimuovi un progetto da Specrails, l'app fa pulizia del proprio stato per progetto sotto `~/.specrails/`. Le spec già committate nel tuo repo restano dove devono stare — nel tuo repo — perché sono tue.

## Worktree delle esecuzioni conservati su disco {#retained-worktrees}

Ogni esecuzione di un rail lavora nel proprio worktree Git in `~/.specrails/projects/<progetto>/worktrees/`. Quando un'esecuzione termina, Specrails rimuove quel worktree, ma solo se può dimostrare che non si perderà nulla. Se non può (modifiche non committate, file che esistono solo lì o una rimozione non riuscita), lo conserva. Col tempo si accumulano.

**Impostazioni ▸ Archiviazione** li elenca per tutti i progetti. Puoi arrivarci anche dal popover **Risorse dell'app** nella barra di stato. Ogni worktree mostra la sua dimensione (misurata in background), da quanto è inattivo, la sua PR e cosa si perderebbe rimuovendolo:

- **Niente da perdere**: nessuna modifica non committata, e ogni file ignorato è rigenerabile (`node_modules`), un link o identico allo stesso file nel checkout principale (ad esempio un `.env` copiato). Ogni commit del suo branch è su un remote o su un altro branch, oppure la sua consegna è stata unita.
- **Ti aspetta**: qualcosa ha ancora bisogno di te. Ogni motivo è indicato: modifiche non committate, file ignorati che esistono solo lì, commit solo su questo branch, una consegna che attende la tua decisione, attività recente (l'ultima ora) o Git non è riuscito a verificarlo. Un worktree che Git non riesce a verificare non è mai considerato pulito.

Seleziona i worktree e scegli **Rimuovi**. La conferma indica quanto spazio recuperi e cosa succede ai branch:

- Per impostazione predefinita i branch vengono **conservati**, quindi i loro commit restano disponibili.
- Con **Elimina anche i branch che non contengono nulla di nuovo**, un branch viene eliminato solo se non ha niente da perdere e solo se punta ancora al commit verificato da Specrails.

I worktree con modifiche non committate o file che esistono solo lì non si possono selezionare. Prima fai commit di quel lavoro, copialo o scartalo. Un worktree che appartiene a una sessione Intent compare nell'elenco ma si gestisce dalla sua sessione. Subito prima della rimozione ogni worktree viene ricontrollato: se qualcosa è cambiato dopo la tua conferma, viene conservato e il risultato spiega perché. I processi ancora attivi in un worktree rimosso (ad esempio un server di sviluppo) vengono fermati.
