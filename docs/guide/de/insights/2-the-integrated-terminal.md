# Das integrierte Terminal

Specrails hat ein echtes Terminal direkt eingebaut – das Panel, das vom unteren Rand des Fensters nach oben fährt, genau wie in VS Code oder Cursor. Es führt deine tatsächliche Shell in deinem tatsächlichen Projektverzeichnis aus, sodass du `git`, `npm`, Tests oder alles andere ausführen kannst, ohne die App zu verlassen.

## Öffnen und schließen

Am schnellsten geht es über die Tastatur: **Cmd+J** (macOS) bzw. **Ctrl+J** (Windows/Linux) öffnet und schließt das Panel und fokussiert das Terminal in dem Moment, in dem es erscheint, sodass du sofort lostippen kannst. Du kannst auch das Chevron in der Statusleiste verwenden.

Das Panel hat drei Zustände:

- **Ausgeblendet** – weggeräumt.
- **Wiederhergestellt** – das normale Panel in geteilter Höhe.
- **Maximiert** – übernimmt den Arbeitsbereich, wenn du Platz brauchst, um Ausgaben zu lesen.

Das Minimieren des Panels (über das Chevron) beendet **nichts** – deine Shells laufen im Hintergrund weiter. Das Einzige, was eine Sitzung wirklich beendet, ist das Schließen (das Papierkorb-Symbol oder das ✕ pro Tab).

## Mehrere Sitzungen

Du kannst im selben Projekt mehrere Terminals gleichzeitig laufen lassen – bis zu zehn. Jedes bekommt seinen eigenen Tab; du kannst sie umbenennen, damit „Dev-Server“ und „Tests“ nicht durcheinandergeraten. Sie starten alle in deinem Projektordner und laden dein Shell-Profil (`.zshrc`, `.bashrc` und so weiter), sodass deine Aliase und dein PATH genau das sind, was du erwartest.

Und jetzt der wichtige Teil: Deine Terminals **überstehen den Wechsel von Projekten und Tabs**. Specrails hält jede Sitzung im Hintergrund am Leben und intakt – Scrollback, laufende Prozesse, einfach alles –, sodass ein Abstecher zu Analytics und zurück deine Shell nicht zurücksetzt oder einen lang laufenden Befehl unterbricht. Sitzungen enden nur, wenn du sie ausdrücklich schließt (oder wenn du das gesamte Projekt entfernst).

## Pro Projekt, gemerkt

Ob das Panel geöffnet ist, wie hoch du es gezogen hast, welche Tabs existieren – all das wird **pro Projekt** gemerkt. Kehrst du zu einem Projekt zurück, ist es so eingerichtet, wie du es verlassen hast.

## Die Premium-Funktionen

Das ist keine Konsole von der Stange. Das Terminal bringt die Annehmlichkeiten mit, die du von einem erstklassigen Terminal erwartest:

- **Schnelles, gestochen scharfes Rendering** dank WebGL (mit automatischem Fallback, damit es nie kaputtgeht), vollständiger Unicode-Breitenbehandlung und Schrift-Ligaturen.
- **Durchsuche deinen Scrollback** mit **Cmd+F** – ideal, um den Fehler zu finden, der 500 Zeilen weiter oben vergraben liegt.
- **Schrift-Zoom** mit **Cmd+=**, **Cmd+-** und **Cmd+0** zum Zurücksetzen.
- **Zwischenablage-Kürzel** – Cmd+C / Cmd+V zum Kopieren und Einfügen, Cmd+K zum Leeren – plus ein Kontextmenü per Rechtsklick.
- **Dateipfade per Drag-and-drop** (in der Desktop-App): Ziehe eine Datei auf das Terminal, und ihr Pfad wird eingefügt – korrekt für deine Shell maskiert.
- **Sanftes Anpassen der Größe** – das Ziehen der Panel-Höhe oder das Einklappen der Seitenleiste lässt die Ausgabe nicht ruckeln.
- **Inline-Bilder** – Terminals, die Bilder im Sixel- oder iTerm2-Stil ausgeben, stellen sie direkt an Ort und Stelle dar.
- **Shell-Integration** – Specrails weiß, wo jeder Befehl beginnt und endet, kann also deinen Befehlsverlauf nachverfolgen und dich benachrichtigen, wenn ein lang laufender Befehl fertig ist (eine Desktop-Benachrichtigung, mit Browser-Fallback). Falls deine Shell aus irgendeinem Grund nicht instrumentiert werden kann, läuft alles leise weiter und du wirst einmal darauf hingewiesen.

## Einstellungen

Terminal-Einstellungen liegen auf zwei Ebenen: einer app-weiten Voreinstellung und einer optionalen projektspezifischen Überschreibung. Die projektspezifische Einstellung gewinnt, wenn sie vorhanden ist, sodass du ein globales Erscheinungsbild beibehalten und gleichzeitig ein einzelnes Projekt anpassen kannst, das etwas anderes braucht.

## Ausschalten

Das Terminal ist standardmäßig aktiviert. Wenn du es lieber nicht haben möchtest, kannst du es über die Flags `VITE_FEATURE_TERMINAL_PANEL` (Client) oder `SPECRAILS_TERMINAL_PANEL` (Server) deaktivieren – setze eines der beiden auf `false`. Die meisten lassen es einfach an.
