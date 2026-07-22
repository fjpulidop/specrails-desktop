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

## Anbieter werden automatisch erkannt

Du wählst nie Anbieter pro Projekt aus. Specrails erkennt jedes auf deinem
Rechner installierte Anbieter-CLI und stellt **alle** davon **jedem** Projekt
zur Verfügung, immer. Jede Oberfläche prüft anschließend die vom Anbieter
angekündigten Fähigkeiten. Siehe [Kimi verwenden](../../../kimi.md) für Kimis
genaue Matrix.

Wenn ein gewünschter Anbieter nirgends auftaucht, liegt es fast immer daran,
dass das CLI nicht installiert oder nicht im `PATH` ist. Installiere es, melde
dich an und wechsle zurück zur App — die Erkennung läuft beim Fokussieren
erneut und der Anbieter erscheint von selbst überall, seine Workspace-Oberfläche
wird im Hintergrund zusammengebaut. Ein installierter, aber nicht angemeldeter
Anbieter erscheint trotzdem, mit einem *Nicht angemeldet*-Badge in den
Engine-Auswahlmenüs.

Wissenswertes zu Maschinen mit mehreren Anbietern:

- **Ein einzelner Anbieter verhält sich exakt wie zuvor.** Wird nur einer erkannt, siehst du nirgendwo einen Anbieter-Picker — die App bleibt schlicht und einfach.
- **Fähigkeiten steuern die Seitenleiste.** Eine Sektion ist sichtbar, wenn
  mindestens ein erkannter Anbieter sie unterstützt; darin bieten engine-bezogene
  Aktionen nur die fähigen Anbieter an. Kimi kündigt Profile, eigene Rollen und
  Freestyle an; keine strukturierten Aktionen, die eine durchsetzbare
  No-Tools-Grenze erfordern.
- **Nichts ist fixiert.** Das Installieren oder Entfernen eines Anbieter-CLIs
  aktualisiert alle Projekte automatisch — es gibt keine Anbieter-Einstellung pro
  Projekt zu verwalten.

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
