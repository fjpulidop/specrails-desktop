# Dove vivono i tuoi dati

In breve: **Specrails mantiene i tuoi repository immacolati.** Quando punti l'app a uno dei tuoi progetti, non ci si insedia, non sparpaglia file di configurazione in giro e non riscrive nulla che non gli abbia chiesto. Il tuo codice resta tuo, e pulito.

## Il tuo repo resta pulito

I file di Specrails — i suoi database, lo stato per progetto, le definizioni degli agent, le impostazioni, la telemetria, i riassunti e tutto il resto che gli serve per funzionare — vivono in un'unica casa ordinata sotto la tua home directory:

```
~/.specrails/
```

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
