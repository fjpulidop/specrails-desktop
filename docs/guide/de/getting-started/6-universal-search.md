# Universelle Suche (⌘K)

Drücke **⌘K** (**Strg+K** unter Windows und Linux), um fast alles in Specrails an einer Stelle zu durchsuchen: Missionen, Specs, Job-Protokolle, Dateien, Einstellungen und diese Anleitung. Gib eine normale Suchanfrage ein, um wie bisher Missionen, Projekte, Specs und aktuelle Jobs zu durchsuchen, oder beginne mit einem **Präfix**, um nur eine Quelle zu durchsuchen.

## Weitermachen

Bei leerem Feld ist die erste Gruppe **Weitermachen**: deine zuletzt aktiven Missionen und Jobs, die neuesten zuerst, wobei der neueste des geöffneten Projekts vorne steht, damit **Enter** dich dort lässt, wo du bist. Jede Zeile zeigt die Statuslampe und den Projektnamen, wenn es nicht das geöffnete Projekt ist. Wenn etwas auf dich wartet, sagt eine Zeile ganz oben, wie viele Dinge es sind (**3 offene Punkte**), und öffnet den Posteingang, die eine Liste dessen, was auf dich wartet; die Einträge des Posteingangs selbst stehen hier nicht.

Drücke **⌘1** bis **⌘6** (**Strg+1** bis **Strg+6** unter Windows und Linux), um eine Missions- oder Jobzeile direkt zu öffnen (die Posteingangszeile hat keine Nummer), oder wähle eine Zeile mit den Pfeiltasten und **Enter**. Eine Zeile öffnet sich genau wie an anderer Stelle: eine Mission öffnet die Mission, ein Job den Job. Solange die Palette offen ist, gehören ihr diese Tasten: die Seitenkürzel (⌘1–5) und der Projektwechsel (⌥⌘1–9) warten, bis sie geschlossen ist. Die Reihenfolge bleibt fest, solange die Palette offen ist, damit keine Zeile unter deinem Finger wandert; Status werden trotzdem aktualisiert, und beim nächsten Öffnen wird neu sortiert. Zeilen aus dieser Gruppe erscheinen nicht noch einmal unter Missionen oder Jobs.

## Präfixe

| Eingabe | Durchsucht | Enter öffnet |
| --- | --- | --- |
| `#` | Specs: Titel, Zusammenfassung, Beschreibung, Labels, Notizen zum Ausschluss, Nachträge und Kommentare. `#12` findet Spec 12. | Die Spec |
| `@` | Missionen: Titel und Gesprächsinhalt. | Die Mission |
| `/` | Einstellungen (Desktop und Projekt) nach Name oder nach dem, wie du sie nennen würdest. | Das Einstellungsfenster an diesem Block, sichtbar und fokussiert |
| `f:` | Dateien des Projekts nach Name oder Pfad. | Die Datei im Code-Explorer |
| `log:` | Job-Protokolle: Befehle, Loop-Namen, Phasentitel und Fehlerdiagnosen. | Der Job |
| `?` | Diese Anleitung: Seitentitel und Überschriften. | Die Anleitung an dieser Überschrift |

Ein getipptes Präfix wird zu einem **Chip** im Suchfeld, und das Feld behält nur deine Anfrage. Drücke **Rücktaste** bei leerem Feld (oder klicke auf das × des Chips), um den Bereich zu entfernen. Bei leerem Feld listet die Palette die Präfixe unter dem Feld auf; klicke eines an, um zu starten. `>` listet weiterhin Aktionen auf.

## Hervorhebung

Treffer zeigen einen kurzen Ausschnitt um die erste Übereinstimmung, mit hervorgehobenem Text. Die Suche ignoriert Groß- und Kleinschreibung sowie Akzente, `revision` findet also „Révision“.

## Einstellungen

`/` kennt die wichtigsten Einstellungsblöcke in deiner Sprache: Design, Sprache, Editor, Budgets, Benachrichtigungen, Webhooks, Updates, Branch, Umgebung, Telemetrie, Regeln und mehr. Projekteinstellungen werden angeboten, wenn ein Projekt geöffnet ist. Wähle eine aus, und das richtige Fenster öffnet sich an diesem Block. Ohne Präfix fügt ein starker Treffer (ab drei Zeichen) den normalen Ergebnissen bis zu drei Einstellungen hinzu. `/budget` findet auch das Budget-Panel (Limits, Prognose, Was-wäre-wenn), in dem das Wochen- und das Monatslimit liegen. Ein Slash-Befehl wie `/implement` steht unter den Einstellungen in einer eigenen Gruppe, das Präfix `/` blendet ihn also nie aus.

## Job-Protokolle

`log:` durchsucht einen kompakten Index, nicht die Rohausgabe eines Laufs: den Befehl, den Loop-Namen, die Phasentitel und die kurze Diagnose eines fehlgeschlagenen, blockierten oder hängenden Laufs. Token-Streams und Tool-Ausgaben werden nie gespeichert, daher bleibt er klein und schnell. Er wird pro Projekt geführt und enthält die neuesten Läufe.

## Gut zu wissen

- `#`, `f:` und `log:` durchsuchen das aktive Projekt; öffne zuerst ein Projekt.
- Der Datei-Bereich beachtet die Ausschlussregeln des Code-Explorers.
- Jede Gruppe zeigt nur ihre besten Treffer; verfeinere die Anfrage, um einzugrenzen.
