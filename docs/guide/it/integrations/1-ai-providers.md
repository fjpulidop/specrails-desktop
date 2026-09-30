# Provider AI (Claude, Codex)

## I due provider

| Provider | CLI | Realizzato da | Note |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Costo nativo e trasporto interattivo persistente. |
| **Codex** | `codex` | OpenAI | Richiede codex `0.128.0+`. Legge i suoi server MCP dal file globale `~/.codex/config.toml`. |

## I provider vengono rilevati automaticamente

Se un provider che vuoi non compare da nessuna parte, è quasi sempre perché la
CLI non è installata o non è nel tuo `PATH`. Installala, accedi e torna
sull'app — il rilevamento si riesegue al focus della finestra e il provider
appare ovunque da solo, con la sua superficie di workspace assemblata in
background. Un provider installato ma non connesso appare comunque, con un
badge *Non connesso* nei selettori di engine.

Alcune cose utili sulle macchine multi-provider:

- **Un solo provider si comporta esattamente come prima.** Se ne viene rilevato uno solo, non vedrai mai un selettore di provider — l'app resta pulita e semplice.
- **Niente è bloccato.** Installare o rimuovere una CLI di provider aggiorna
  tutti i progetti automaticamente — non c'è alcuna impostazione di provider per
  progetto da gestire.

## Scegliere un provider per ogni invocazione

Il vero vantaggio di un progetto multi-provider è poter scegliere l'AI giusta per ciascun task — senza toccare alcuna impostazione globale. Ovunque venga eseguita un'AI compare un piccolo selettore di provider (solo quando il progetto ne ha più di uno):

- **Intestazione del rail** — scegli il motore per quello specifico rail prima di avviarlo.
- **Terminale** — il pulsante "Open AI CLI" (Sparkles) apre un menu dei provider così puoi entrare in una qualsiasi CLI installata nella cartella di quel progetto.

La tua scelta viene ricordata per progetto, con il provider primario come default, così non devi riselezionarla ogni volta.

## Risoluzione dei problemi

- **I server MCP di Codex non si caricano in chat.** Codex legge i server MCP dal file globale `~/.codex/config.toml` — registrali lì con `codex mcp add`.
