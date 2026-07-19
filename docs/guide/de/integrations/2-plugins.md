# Plugins (Integrationen)

Der Bereich **Integrationen** ist ein projektbezogener Marktplatz für optionale Erweiterungen, die den Funktionsumfang der KI ausbauen. Jedes Projekt entscheidet eigenständig, welche Plugins es haben möchte — ein Plugin in einem Projekt zu installieren, berührt nie ein anderes.

Plugins funktionieren, indem sie unauffällig einen **MCP-Server** (Model Context Protocol) in deinem Projekt registrieren und der KI so neue Tools an die Hand geben, die sie während Rails und Chat aufrufen kann. Du musst MCP nicht verstehen, um sie zu nutzen — installieren, und beim nächsten Rail-Lauf stehen sie bereit.

## Was heute verfügbar ist

Diese Version wird **ausschließlich gebündelt** ausgeliefert: Die installierbaren Plugins sind die, die in die App eingebaut sind. Es gibt keine Remote-Registry, keine von Nutzern hochgeladenen Plugins und kein Laden von Drittanbieter-Code — alles im Katalog ist also geprüft und wird mit Specrails ausgeliefert.

Das Vorzeige-Plugin ist:

- **Serena** — semantische Code-Navigation. Es gibt der KI ein vom Language-Server gestütztes Verständnis deiner Codebasis (Gehe-zu-Definition, Referenzen finden, symbolbewusste Suche) statt schlichtem Textabgleich. Ideal für größere oder unbekannte Repos, in denen der Agent über echte Symbole schlussfolgern soll.

  Serena benötigt das Tool `uv` in deinem `PATH` (es läuft über `uvx`). Die App erkennt automatisch, ob `uv` vorhanden ist, und weist dich darauf hin, falls es fehlt.

## Ein Plugin installieren

1. Öffne **Integrationen** über die rechte Seitenleiste.
2. Finde das Plugin im Katalog. Jede Karte zeigt einen Status: **Nicht installiert**, **Installiert**, **Beeinträchtigt** oder **Verwaist**.
3. Klicke in das Plugin hinein, um die **Installation vorab anzusehen** — das zeigt dir genau, welche Dateien sich ändern werden, bevor irgendetwas passiert.
4. Klicke auf **Installieren**. Du siehst den Fortschritt live, während es eingerichtet wird.

Im Hintergrund läuft die Installation *chirurgisch und additiv*: Sie ergänzt nur die native MCP-Konfiguration des gewählten Providers (und bei manchen Claude-Installationen ein Fragment unter `.claude/agents/`). Sie schreibt die Konfiguration nie komplett neu und rollt bei fehlgeschlagener Verifikation sauber zurück.

## Installierte Plugins verwalten

- **Gesundheit.** Jedes Plugin hat eine Gesundheitsprüfung auf Abruf. Ein Plugin, das sich zwar installieren lässt, später aber nicht starten kann, wird als **Beeinträchtigt** markiert — es blockiert deine Rails nicht, du siehst nur das Badge und einen Grund.
- **Deinstallieren.** Beim Entfernen eines Plugins werden chirurgisch nur die Einträge gelöscht, die ihm gehören; der Rest deiner Konfiguration bleibt unangetastet.
- **Verwaiste Einträge.** Bleiben die Dateien eines Plugins ohne sauberen Zustand zurück (etwa nach einer abgebrochenen Änderung), erscheint es als **Verwaist** und du kannst es mit einem Klick aufräumen.

## Wie Plugins in deiner Arbeit auftauchen

- **Rails.** Bevor eine Rail läuft, prüft Specrails, welche Plugins installiert und fehlerfrei sind, und stellt deren Tools dem Agent für diesen Job bereit. Ein beeinträchtigtes Plugin wird für diesen Lauf einfach übersprungen — die Rail startet trotzdem normal. Jeder Job speichert einen Schnappschuss davon, welche Plugins aktiv waren; den siehst du im diagnostischen Export des Jobs.
- **Chat.** Der Chat übernimmt automatisch die MCP-Konfiguration deines Projekts, sodass installierte Plugins auch dort verfügbar sind.
- **Einrichtung.** Während ein Projekt noch eingerichtet wird, werden Plugins ignoriert — sie kommen ins Spiel, sobald das Projekt bereit ist.

## Anbieterhinweise

Plugins sind anbieterbewusst. Serena unterstützt Claude über `.mcp.json`, Codex über `codex mcp add` mit isoliertem `CODEX_HOME` pro Projekt und Kimi über `.kimi-code/mcp.json`. Ein Plugin erscheint nur, wenn sein Manifest den Provider deklariert; Serena wird daher für Gemini nicht angeboten. Die Jira-Karte ist providerunabhängig.

## Reservierte Dateien

Plugins verwalten die native MCP-Konfiguration des Providers, Zustand unter `.specrails/plugins/` und nur bei Bedarf für Claude Fragmente unter `.claude/agents/custom-<plugin>.md`. Kimi-Einträge liegen in `.kimi-code/mcp.json`; die App schreibt keine Claude-Fragmente für Kimi und überschreibt Konfigurationen nie blind.
