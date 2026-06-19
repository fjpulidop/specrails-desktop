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

Im Hintergrund läuft die Installation *chirurgisch und additiv* ab: Sie fügt der `.mcp.json` deines Projekts nur ihre eigenen Einträge hinzu (und bei manchen Plugins eine Fragment-Datei im geschützten `.claude/agents/`-Namensraum). Sie schreibt deine Konfiguration nie komplett neu, und ein zweites Plugin kann das erste niemals stören. Kann sich eine Installation nicht als fehlerfrei verifizieren, wird sie sauber zurückgerollt.

## Installierte Plugins verwalten

- **Gesundheit.** Jedes Plugin hat eine Gesundheitsprüfung auf Abruf. Ein Plugin, das sich zwar installieren lässt, später aber nicht starten kann, wird als **Beeinträchtigt** markiert — es blockiert deine Rails nicht, du siehst nur das Badge und einen Grund.
- **Deinstallieren.** Beim Entfernen eines Plugins werden chirurgisch nur die Einträge gelöscht, die ihm gehören; der Rest deiner Konfiguration bleibt unangetastet.
- **Verwaiste Einträge.** Bleiben die Dateien eines Plugins ohne sauberen Zustand zurück (etwa nach einer abgebrochenen Änderung), erscheint es als **Verwaist** und du kannst es mit einem Klick aufräumen.

## Wie Plugins in deiner Arbeit auftauchen

- **Rails.** Bevor eine Rail läuft, prüft Specrails, welche Plugins installiert und fehlerfrei sind, und stellt deren Tools dem Agent für diesen Job bereit. Ein beeinträchtigtes Plugin wird für diesen Lauf einfach übersprungen — die Rail startet trotzdem normal. Jeder Job speichert einen Schnappschuss davon, welche Plugins aktiv waren; den siehst du im diagnostischen Export des Jobs.
- **Chat.** Der Chat übernimmt automatisch die MCP-Konfiguration deines Projekts, sodass installierte Plugins auch dort verfügbar sind.
- **Einrichtung.** Während ein Projekt noch eingerichtet wird, werden Plugins ignoriert — sie kommen ins Spiel, sobald das Projekt bereit ist.

## Anbieterhinweise

Plugins sind anbieterbewusst. Serena und ähnliche MCP-Plugins greifen bei Anbietern, die MCP über die `.mcp.json` des Projekts registrieren (Claude und Gemini). Bei Codex-Projekten werden MCP-Server stattdessen über Codex' eigene globale Konfiguration verwaltet, sodass Plugin-Einträge in **Integrationen** entsprechend gefiltert werden. Die Jira-Karte in den Integrationen ist anbieterunabhängig und erscheint für alle — siehe den Jira-Guide.

## Reservierte Dateien

Plugins verwalten eine kleine, klar abgegrenzte Menge an Dateien in deinem Projekt: deine `.mcp.json` (chirurgisch zusammengeführt), etwas Zustand unter `.specrails/plugins/` sowie pro Plugin Agenten-Fragmente unter `.claude/agents/custom-<plugin>.md`. Das sind committbare Team-Assets, falls du eine Integration mit deinen Teamkolleg:innen teilen möchtest — die App überschreibt sie nie blind.
