# Provider AI (Claude, Codex, Gemini)

Specrails non è legato a una sola AI. Ogni parte dell'app che dialoga con un'AI — Explore Spec, Quick spec, i rail, la chat, AI Edit, il pulsante "Open AI CLI" del terminale — può funzionare con uno qualsiasi dei tre provider di prima classe. Scegli tu quali usare in un progetto, e puoi addirittura cambiare provider task per task.

## I tre provider

| Provider | CLI | Realizzato da | Note |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Il più completo. È l'unico provider per gli Agenti (profili), i rail Freestyle e il Contract Refine. |
| **Codex** | `codex` | OpenAI | Richiede codex `0.128.0+`. Legge i suoi server MCP dal file globale `~/.codex/config.toml`. |
| **Gemini** | `gemini` | Google | Richiede gemini `0.11.0+`. Usa la telemetria nativa e un file di istruzioni `GEMINI.md`. |

Tutti e tre sono **abilitati di default**. Un provider compare in **Add Project** ogni volta che la sua CLI è installata e presente nel tuo `PATH`. Quindi il primo passo è sempre lo stesso: installa la CLI che vuoi usare e accedi con essa, esattamente come descritto nella documentazione di quello strumento. Una volta che `claude --version` (o `codex`, o `gemini`) funziona nel tuo terminale, Specrails può usarla.

## Installare un provider per un progetto

Quando aggiungi un progetto, la procedura guidata di setup ti chiede quale provider (o quali provider) installare. Scegline uno, completa il passo di installazione e hai finito. Da quel momento il progetto *ha* semplicemente quel provider — non dovrai più pensarci. Spec, rail, chat e analisi funzionano tutti allo stesso modo, indipendentemente da quale hai scelto.

Se una CLI che vuoi usare non viene proposta in Add Project, quasi sempre è perché la CLI non è installata oppure non è presente nel tuo `PATH`. Installala e poi riapri Add Project.

## Installare più provider in un solo progetto

Puoi installare **più di un** provider nello stesso progetto — per esempio Claude *e* Gemini. In **Add Project** l'elenco dei provider diventa una serie di caselle di spunta: seleziona tutti quelli che ti servono. Il primo che selezioni diventa il provider **primario** (predefinito) del progetto; gli altri restano disponibili come alternative.

Qualche cosa utile da sapere sui progetti multi-provider:

- **Con un solo provider tutto si comporta esattamente come prima.** Se un progetto ha un unico provider, non vedrai mai un selettore di provider da nessuna parte — l'app resta pulita e semplice.
- **La barra laterale destra mostra solo le sezioni supportate da tutti i provider installati.** Poiché gli Agenti (profili) sono un concetto esclusivo di Claude, la sezione **Agenti** scompare nel momento in cui un progetto include un provider diverso da Claude. Tutto il resto (Spec, Code, Analisi, Integrazioni, Terminale, Chat) rimane.
- **La scelta dei provider è bloccata dopo la creazione.** In questa versione scegli i tuoi provider quando aggiungi il progetto e non possono essere modificati in seguito dalle Impostazioni. Se ti serve un mix diverso, crea un nuovo progetto.

## Scegliere un provider per ogni invocazione

Il vero vantaggio di un progetto multi-provider è poter scegliere l'AI giusta per ciascun task — senza toccare alcuna impostazione globale. Ovunque venga eseguita un'AI compare un piccolo selettore di provider (solo quando il progetto ne ha più di uno):

- **Add Spec** — un selettore di motore ti permette di esplorare o generare in modalità Quick una spec con il provider che preferisci.
- **Intestazione del rail** — scegli il motore per quello specifico rail prima di avviarlo.
- **Terminale** — il pulsante "Open AI CLI" (Sparkles) apre un menu dei provider così puoi entrare in una qualsiasi CLI installata nella cartella di quel progetto.

La tua scelta viene ricordata per progetto, con il provider primario come default, così non devi riselezionarla ogni volta.

## Cosa può fare solo Claude

Alcune funzioni sono per natura specifiche di Claude, quindi vengono nascoste o saltate quando è in uso un altro provider:

- **Agenti (profili)** — il catalogo degli agenti per progetto e il routing dei modelli. Nascosti in qualsiasi progetto che includa un provider diverso da Claude.
- **Rail Freestyle** — vengono sempre eseguiti su Claude.
- **Contract Refine** — il passaggio aggiuntivo "Contract Layer" su una spec confermata viene eseguito solo quando il provider della conversazione è Claude.
- **Modalità avanzate di Add Spec** (SMASH / Contract Layer) — nascoste per i motori diversi da Claude.

Tutto il resto — Explore, Quick spec, l'intera pipeline dei rail, AI Edit, chat, analisi dei costi — funziona con tutti e tre.

## Tracciamento dei costi tra i provider

La pagina **Analisi** traccia ogni invocazione fatturabile, indipendentemente dal provider. Sui progetti multi-provider aggiunge dei chip di filtro per motore così puoi confrontare la spesa per provider. Claude riporta il proprio costo esatto; per Codex e Gemini, Specrails stima il costo da un listino integrato, quindi i numeri sono approssimazioni vicine al reale più che importi effettivamente addebitati.

## Risoluzione dei problemi

- **Un provider che ho installato non viene proposto.** Verifica che la CLI sia presente nel tuo `PATH` (prova `claude --version` / `codex --version` / `gemini --version` in un terminale nuovo). L'app sonda le CLI dei provider tramite il `PATH` di sistema.
- **I server MCP di Codex non si caricano in chat.** Codex legge i server MCP dal file globale `~/.codex/config.toml` — registrali lì con `codex mcp add`.
- **Disabilitazione d'emergenza.** Un provider può essere disattivato a livello di app tramite una variabile d'ambiente (`SPECRAILS_CODEX_BETA=0` o `SPECRAILS_GEMINI_BETA=0`). Questo nasconde il provider solo dalla *selezione*; raramente è necessario.

## Vedi anche

Le guide dedicate ai provider approfondiscono ciascuna CLI: la guida di Codex e la guida di Gemini coprono ognuna il setup, cosa funziona e le particolarità specifiche del provider.
