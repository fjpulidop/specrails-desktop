# KI-Anbieter (Claude, Codex)

## Die zwei Anbieter

| Anbieter | CLI | Hersteller | Hinweise |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Native Kosten und persistenter interaktiver Transport. |
| **Codex** | `codex` | OpenAI | Benötigt codex `0.128.0+`. Liest seine MCP-Server aus deiner globalen `~/.codex/config.toml`. |

## Anbieter werden automatisch erkannt

Wenn ein gewünschter Anbieter nirgends auftaucht, liegt es fast immer daran,
dass das CLI nicht installiert oder nicht im `PATH` ist. Installiere es, melde
dich an und wechsle zurück zur App — die Erkennung läuft beim Fokussieren
erneut und der Anbieter erscheint von selbst überall, seine Workspace-Oberfläche
wird im Hintergrund zusammengebaut. Ein installierter, aber nicht angemeldeter
Anbieter erscheint trotzdem, mit einem *Nicht angemeldet*-Badge in den
Engine-Auswahlmenüs.

Wissenswertes zu Maschinen mit mehreren Anbietern:

- **Ein einzelner Anbieter verhält sich exakt wie zuvor.** Wird nur einer erkannt, siehst du nirgendwo einen Anbieter-Picker — die App bleibt schlicht und einfach.
- **Nichts ist fixiert.** Das Installieren oder Entfernen eines Anbieter-CLIs
  aktualisiert alle Projekte automatisch — es gibt keine Anbieter-Einstellung pro
  Projekt zu verwalten.

## Pro Aufruf einen Anbieter wählen

Der eigentliche Gewinn eines Multi-Anbieter-Projekts liegt darin, für jede Aufgabe die richtige KI zu wählen — ohne irgendeine globale Einstellung zu ändern. Überall dort, wo eine KI läuft, erscheint eine kleine Anbieterauswahl (nur, wenn das Projekt mehr als einen Anbieter hat):

- **Rail-Kopf** — wähle die Engine für genau diese Rail, bevor du sie startest.
- **Terminal** — der „Open AI CLI“-Button (Sparkles) öffnet ein Anbietermenü, über das du in jede installierte CLI im Verzeichnis dieses Projekts springen kannst.

Deine Wahl wird pro Projekt gemerkt und fällt standardmäßig auf den primären Anbieter zurück — du musst also nicht jedes Mal neu wählen.

## Fehlerbehebung

- **Codex-MCP-Server werden im Chat nicht geladen.** Codex liest MCP-Server aus deiner globalen `~/.codex/config.toml` — registriere sie dort mit `codex mcp add`.
