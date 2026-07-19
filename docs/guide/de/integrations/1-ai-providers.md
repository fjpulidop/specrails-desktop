# KI-Anbieter (Claude, Codex, Gemini, Kimi)

Specrails ist nicht an eine einzige KI gebunden. Claude, Codex, Gemini und
Kimi sind vollwertige Anbieter; jede Oberfläche zeigt nur Engines, deren
Fähigkeiten ihren Vertrag erfüllen.

## Die vier Anbieter

| Anbieter | CLI | Hersteller | Hinweise |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Native Kosten und persistenter interaktiver Transport. |
| **Codex** | `codex` | OpenAI | Benötigt codex `0.128.0+`. Liest seine MCP-Server aus deiner globalen `~/.codex/config.toml`. |
| **Gemini** | `gemini` | Google | Benötigt gemini `0.11.0+`. Nutzt native Telemetrie und eine `GEMINI.md`-Instruktionsdatei. |
| **Kimi Code** | `kimi` | Moonshot AI | Benötigt Kimi `0.27.0+`. Desktop startet die externe CLI mit `-p`; kein Server wird installiert oder gestartet. |

Alle vier sind **standardmäßig aktiviert**. Ein Anbieter erscheint, wenn seine
CLI im `PATH` liegt. Für Kimi: `kimi --version` prüfen und `kimi login`
ausführen.

## Einen Anbieter für ein Projekt installieren

Wenn du ein Projekt hinzufügst, fragt dich der Einrichtungsassistent, welche(n) Anbieter du installieren möchtest. Wähle einen aus, klicke dich durch den Installationsschritt — fertig. Ab da *hat* das Projekt diesen Anbieter einfach, und du musst nie wieder darüber nachdenken. Specs, Rails, Chat und Analytics funktionieren gleich, egal für welchen du dich entschieden hast.

Falls eine gewünschte CLI in „Projekt hinzufügen“ nicht angeboten wird, liegt das fast immer daran, dass die CLI nicht installiert ist oder nicht in deinem `PATH` liegt. Installiere sie und öffne „Projekt hinzufügen“ erneut.

## Mehrere Anbieter für ein Projekt installieren

Du kannst **mehr als einen** Anbieter in dasselbe Projekt installieren — zum Beispiel Claude *und* Gemini. In **Projekt hinzufügen** wird die Anbieterliste zu einer Reihe von Checkboxen; hake alles an, was du möchtest. Der erste, den du auswählst, wird zum **primären** (Standard-)Anbieter des Projekts; die übrigen stehen als Alternativen bereit.

Ein paar Dinge, die du über Multi-Anbieter-Projekte wissen solltest:

- **Ein einzelner Anbieter verhält sich genau wie zuvor.** Hat ein Projekt nur einen einzigen Anbieter, siehst du nirgendwo eine Anbieterauswahl — die App bleibt schlank und einfach.
- **Fähigkeiten steuern die UI.** Claude und Kimi unterstützen getrennte
  provider-spezifische Profile; Codex und Gemini laufen im Legacy-Modus.
- **Die Anbieterwahl ist nach dem Anlegen festgelegt.** In dieser Version wählst du deine Anbieter beim Hinzufügen des Projekts, und sie lassen sich später nicht mehr über die Einstellungen ändern. Brauchst du eine andere Kombination, ist das ein neues Projekt.

## Pro Aufruf einen Anbieter wählen

Der eigentliche Gewinn eines Multi-Anbieter-Projekts liegt darin, für jede Aufgabe die richtige KI zu wählen — ohne irgendeine globale Einstellung zu ändern. Überall dort, wo eine KI läuft, erscheint eine kleine Anbieterauswahl (nur, wenn das Projekt mehr als einen Anbieter hat):

- **Spec hinzufügen** — Explore unterstützt Kimi; Quick Spec zeigt nur
  Provider mit einer sicheren Pure-Output-Grenze und daher kein Kimi.
- **Rail-Kopf** — wähle die Engine für genau diese Rail, bevor du sie startest.
- **Terminal** — der „Open AI CLI“-Button (Sparkles) öffnet ein Anbietermenü, über das du in jede installierte CLI im Verzeichnis dieses Projekts springen kannst.

Deine Wahl wird pro Projekt gemerkt und fällt standardmäßig auf den primären Anbieter zurück — du musst also nicht jedes Mal neu wählen.

## Unterschiede der Fähigkeiten

Kimi unterstützt Project/Agent Chat, Explore/Proposals, Quick Launcher
(`/opsx:ff`), Rails, Freestyle, Loops ohne Decider, Profile/manuelle Rollen,
MCP, Serena, Terminal und Anhänge.

`kimi -p` genehmigt Tools automatisch und kann keine No-Tools/Read-only-Grenze
erzwingen. Vor dem Spawn abgelehnt werden daher Quick Spec, AI Edit, Contract
Refine, SMASH/Re-SMASH, Project-Builder-Blueprint/Milestone-Generierung, Loop
Decider, Datei-Zusammenfassungen/Construction Story und Agent-Studio-
Automatisierung. Auto-Title nutzt einen deterministischen Fallback. Siehe
[Kimi-Guide](../../../kimi.md).

## Kostenverfolgung über alle Anbieter hinweg

**Analytics** erfasst tatsächlich gestartete Aufrufe. Claude meldet Kosten,
Codex/Gemini werden geschätzt. Kimi meldet keine autoritativen Tokens oder
USD-Kosten; diese Felder bleiben leer.

## Fehlerbehebung

- **Ein installierter Anbieter wird nicht angeboten.** Prüfe `claude --version` / `codex --version` / `gemini --version` / `kimi --version` in einem frischen Terminal.
- **Codex-MCP-Server werden im Chat nicht geladen.** Codex liest MCP-Server aus deiner globalen `~/.codex/config.toml` — registriere sie dort mit `codex mcp add`.
- **Notabschaltung.** Ein Anbieter lässt sich app-weit über eine Umgebungsvariable abschalten (`SPECRAILS_CODEX_BETA=0` oder `SPECRAILS_GEMINI_BETA=0`). Das blendet den Anbieter nur aus der *Auswahl* aus; es wird selten gebraucht.

## Siehe auch

Siehe die dedizierten Guides für [Kimi](../../../kimi.md), Codex und Gemini.
