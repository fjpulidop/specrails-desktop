# Code-Explorer

Der Bereich **Code** bietet dir ein freundliches, schreibgeschütztes Fenster in dein Repository – besonders gedacht für alle, die verstehen möchten, was die KI gebaut hat, ohne ständig in einem Editor zu leben. Links siehst du einen Dateibaum, rechts einen Code-Viewer und über dem Code eine verständliche Zusammenfassung dessen, was jede Datei tatsächlich tut.

In dieser Version ist alles strikt schreibgeschützt: Nichts, was du hier tust, verändert deine Dateien. Stell dir das eher als Lesesaal vor, nicht als Werkstatt.

Du öffnest ihn über die rechte Seitenleiste (**Code**), und wie alles andere bezieht er sich auf dein aktuelles Projekt.

## Der Dateibaum

Der linke Bereich ist ein virtualisierter Baum der Dateien deines Projekts – schnell selbst bei großen Repos. Er respektiert deine `.gitignore` sowie eine eingebaute Sperrliste, sodass du die Dateien siehst, die zählen, und nicht ein Meer aus Build-Artefakten und `node_modules`.

Neben Dateien fallen dir **Herkunfts-Chips** auf – kleine Markierungen, die dir sagen, dass eine Datei *von der KI bearbeitet* wurde. Das ist das Herzstück des Code-Explorers: Specrails hält fest, welche Dateien jeder Pipeline-Job erstellt oder verändert hat, und verknüpft sie mit dem Ticket, das die Arbeit ausgelöst hat. So kannst du auf einen Blick die Frage beantworten: „Hat die KI das geschrieben oder ich?“

Oben im Baum gibt es einen Filter:

- **Tocado por IA / Von KI bearbeitet** (die Voreinstellung) – nur Dateien, die die KI verändert hat.
- **Alle Dateien** – der vollständige Baum.

Deine Auswahl wird pro Projekt gemerkt, sodass du, wenn dir vor allem KI-erstellte Änderungen wichtig sind, sie jedes Mal zuerst zu sehen bekommst.

## Der Code-Viewer

Klicke auf eine Datei und sie öffnet sich in einem voll ausgestatteten Viewer (angetrieben von Monaco, derselben Engine wie VS Code) mit ordentlichem Syntax-Highlighting, das zu deinem gewählten App-Theme passt. Ein paar sinnvolle Grenzen halten alles flüssig: Binärdateien werden höflich abgelehnt, und sehr große Dateien (über 2 MB) werden nicht geladen.

Deine aktuelle Datei wird in der Seiten-URL gespeichert, sodass du einen Link direkt zu einer bestimmten Datei als Lesezeichen speichern oder teilen kannst.

Da das Bearbeiten in dieser Version nicht vorgesehen ist, bietet der Viewer eine Schaltfläche **In externem Editor öffnen**, die den absoluten Pfad der Datei kopiert – füge ihn in deinen bevorzugten Editor ein und mach dort weiter.

## KI-Zusammenfassungen

Über dem Code siehst du eine **verständliche Zusammenfassung** der Datei – wofür sie da ist, was sie tut – so geschrieben, dass auch Nicht-Entwickler folgen können. Diese werden für dich generiert und zwischengespeichert, sodass das Öffnen einer Datei, die du schon einmal angesehen hast, sofort geht.

Die Zusammenfassungen sind klug, was die Aktualität angeht: Sie sind an den Inhalt der Datei gebunden, sodass eine Zusammenfassung neu generiert wird, wenn sich eine Datei wirklich ändert, unveränderte Dateien aber nicht unnötig erneut zusammengefasst werden. Wenn du eine Datei selbst bearbeitest, wird ihre Zusammenfassung als veraltet markiert statt stillschweigend neu generiert – du behältst die Kontrolle darüber, wann sie aktualisiert wird. Es gibt eine Aktion **Neu generieren**, wenn du bei Bedarf eine frische Einschätzung möchtest.

Ein paar Leitplanken halten die Kosten im Rahmen: Die Generierung von Zusammenfassungen läuft innerhalb eines **monatlichen Budgets** (standardmäßig ein paar Dollar, in den Einstellungen konfigurierbar), und es gibt Obergrenzen dafür, wie viele Zusammenfassungen ein einzelner Job anstoßen darf. Wird eine Zusammenfassung übersprungen, sagt dir die App, warum – Budget erreicht, eine Obergrenze pro Job oder die Datei wurde schlicht nicht gefunden.

Du kannst außerdem die **Sprache der Zusammenfassungen** (Englisch oder Spanisch) in den globalen Einstellungen im Bereich *Code* wählen.

## Die Baugeschichte

Unter dem Code-Viewer lebt die **Baugeschichte** — eine chronologische Zeitleiste jeder Spec und jedes Jobs, die die gerade betrachtete Datei aufgebaut haben. Jedes Kapitel ist eine Karte: welche Spec eingegriffen hat (mit ihrem aktuellen Status), wann, ob die Datei erstellt, geändert oder gelöscht wurde, und wie groß die Änderung war (hinzugefügte und entfernte Zeilen). Ein Klick auf eine Karte öffnet die Detailansicht dieser Spec. Auch Loop-basierte Rails zeichnen ihre Dateiberührungen auf — Arbeit in isolierten Worktrees erscheint in der Geschichte genau wie reguläre Pipeline-Jobs.

Für jedes Kapitel kannst du eine Erklärung in einfacher Sprache anfordern: Drücke **Diese Änderung erklären**, und die App schreibt ein bis drei Sätze darüber, was diese konkrete Änderung zur Datei beigetragen hat — ohne Code, ohne Fachjargon. Erklärungen teilen sich dasselbe Monatsbudget wie die Dateizusammenfassungen; solange noch keine erzeugt wurde, zeigt die Karte die ehrlichen Fakten, die sie kennt: die Art der Änderung, die Spec und das Datum. Lieber Rohdaten? Ein **Geschichte / Protokoll**-Umschalter wechselt zur klassischen Änderungsliste mit Diffs auf Abruf. Dasselbe Panel erscheint im **Files**-Bereich des Agentenmodus.

## Code zurück mit Specs verbinden

Die Herkunftsverknüpfung funktioniert in beide Richtungen. Innerhalb des Code-Explorers öffnet ein Klick auf den Ticket-Chip einer Datei die Detailansicht dieses Tickets. Und aus der anderen Richtung hat die **Ticket-Detailansicht** einen Abschnitt *Von diesem Ticket bearbeitete Dateien* – klicke dort auf eine Datei und du springst direkt in den Code-Explorer, mit der Datei geöffnet. Das schließt den Kreis zwischen „hier ist die Spec, die wir geschrieben haben“ und „hier ist der Code, der dabei herausgekommen ist“.

## Was er (noch) nicht kann

Um die Erwartungen klar zu setzen: Diese erste Version lässt absichtlich ein paar Dinge weg: das Bearbeiten in der App, Zusammenfassungen pro Symbol oder pro Verzeichnis, eine erzählende Diff-Ansicht und das dialogorientierte „Frag die KI zu dieser Datei“. Die Herkunft ordnet eine Datei nur ihrem primären Ticket zu. Das sind die Art von Dingen, die mit der Zeit wachsen könnten.

## Ausschalten

Der Code-Explorer ist standardmäßig aktiviert. Er lässt sich über die Flags `VITE_FEATURE_CODE_EXPLORER` (Client) oder `SPECRAILS_CODE_EXPLORER` (Server) deaktivieren – setze eines der beiden auf `false`. Beim Ausschalten bleiben alle erfassten Daten und Zusammenfassungen sicher und unangetastet auf der Festplatte, falls du ihn wieder einschaltest.
