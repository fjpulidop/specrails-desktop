# Universelle Suche (⌘K)

Drücke **⌘K** (**Strg+K** unter Windows und Linux), um fast alles in Specrails an einer Stelle zu durchsuchen: Missionen, Specs, Job-Protokolle, Dateien, Einstellungen und diese Anleitung. Gib eine normale Suchanfrage ein, um wie bisher Missionen, Projekte, Specs und aktuelle Jobs zu durchsuchen, oder beginne mit einem **Präfix**, um nur eine Quelle zu durchsuchen.

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
