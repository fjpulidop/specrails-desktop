# Provider AI (Claude, Codex, Gemini, Kimi)

Specrails non è legato a una sola AI. Claude, Codex, Gemini e Kimi sono
provider di prima classe; ogni superficie propone solo i motori compatibili
con il proprio contratto.

## I quattro provider

| Provider | CLI | Realizzato da | Note |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Costo nativo e trasporto interattivo persistente. |
| **Codex** | `codex` | OpenAI | Richiede codex `0.128.0+`. Legge i suoi server MCP dal file globale `~/.codex/config.toml`. |
| **Gemini** | `gemini` | Google | Richiede gemini `0.11.0+`. Usa la telemetria nativa e un file di istruzioni `GEMINI.md`. |
| **Kimi Code** | `kimi` | Moonshot AI | Richiede Kimi `0.27.0+`. Desktop avvia la CLI esterna con `-p`; non installa né avvia un server. |

Tutti e quattro sono **abilitati di default**. Il provider compare quando la
CLI è nel `PATH`; per Kimi verifica `kimi --version` ed esegui `kimi login`.

## I provider vengono rilevati automaticamente

Non scegli mai i provider per progetto. Specrails rileva ogni CLI di provider
installata sulla tua macchina e li rende **tutti** disponibili a **ogni**
progetto, sempre. Ogni superficie verifica poi le capability annunciate dal
provider. Vedi [Usare Kimi](../../../kimi.md) per la matrice esatta di Kimi.

Se un provider che vuoi non compare da nessuna parte, è quasi sempre perché la
CLI non è installata o non è nel tuo `PATH`. Installala, accedi e torna
sull'app — il rilevamento si riesegue al focus della finestra e il provider
appare ovunque da solo, con la sua superficie di workspace assemblata in
background. Un provider installato ma non connesso appare comunque, con un
badge *Non connesso* nei selettori di engine.

Alcune cose utili sulle macchine multi-provider:

- **Un solo provider si comporta esattamente come prima.** Se ne viene rilevato uno solo, non vedrai mai un selettore di provider — l'app resta pulita e semplice.
- **Le capability guidano la barra laterale.** Una sezione è visibile quando
  almeno un provider rilevato la supporta; al suo interno, le azioni legate
  all'engine offrono solo i provider capaci. Kimi annuncia profili, ruoli
  personalizzati e Freestyle; non annuncia azioni strutturate che richiedono un
  confine senza strumenti applicabile.
- **Niente è bloccato.** Installare o rimuovere una CLI di provider aggiorna
  tutti i progetti automaticamente — non c'è alcuna impostazione di provider per
  progetto da gestire.

## Scegliere un provider per ogni invocazione

Il vero vantaggio di un progetto multi-provider è poter scegliere l'AI giusta per ciascun task — senza toccare alcuna impostazione globale. Ovunque venga eseguita un'AI compare un piccolo selettore di provider (solo quando il progetto ne ha più di uno):

- **Add Spec** — Explore supporta Kimi; Quick Spec mostra solo provider con un
  confine pure-output sicuro e quindi esclude Kimi.
- **Intestazione del rail** — scegli il motore per quello specifico rail prima di avviarlo.
- **Terminale** — il pulsante "Open AI CLI" (Sparkles) apre un menu dei provider così puoi entrare in una qualsiasi CLI installata nella cartella di quel progetto.

La tua scelta viene ricordata per progetto, con il provider primario come default, così non devi riselezionarla ogni volta.

## Differenze di capability

Kimi supporta Project/Agent Chat, Explore/proposte, Quick Launcher
(`/opsx:ff`), rail, Freestyle, loop senza Decider, profili/ruoli manuali, MCP,
Serena, terminale e allegati.

`kimi -p` approva automaticamente gli strumenti e non può imporre un confine
no-tools/read-only. Sono quindi rifiutati prima dello spawn: Quick Spec, AI
Edit, Contract Refine, SMASH/Re-SMASH, generazione blueprint/milestone di
Project Builder, Loop Decider, riassunti/construction story e automazione
Agent Studio. Auto-title usa un fallback deterministico. Vedi la
[guida Kimi](../../../kimi.md).

## Tracciamento dei costi tra i provider

**Analisi** registra le invocazioni realmente avviate. Claude riporta il
costo; Codex/Gemini usano una stima. Kimi non riporta token o costo USD
autorevoli, quindi i campi restano vuoti.

## Risoluzione dei problemi

- **Un provider che ho installato non viene proposto.** Prova `claude --version` / `codex --version` / `gemini --version` / `kimi --version`.
- **I server MCP di Codex non si caricano in chat.** Codex legge i server MCP dal file globale `~/.codex/config.toml` — registrali lì con `codex mcp add`.
- **Disabilitazione d'emergenza.** Un provider può essere disattivato a livello di app tramite una variabile d'ambiente (`SPECRAILS_CODEX_BETA=0` o `SPECRAILS_GEMINI_BETA=0`). Questo nasconde il provider solo dalla *selezione*; raramente è necessario.

## Vedi anche

Consulta le guide dedicate a [Kimi](../../../kimi.md), Codex e Gemini.
