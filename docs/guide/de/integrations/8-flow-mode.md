# Flow: erst bauen, dann die Spec

Mit Flow baust du gemeinsam mit einem Agenten, wenn du noch nicht genau weißt, was du willst. Du sprichst in deiner Mission mit dem Agenten, er schreibt und startet echten Code in einem isolierten Worktree, und wenn das Ergebnis passt, sagst du **Fertig**: Eine Rail übernimmt den Worktree, leitet die Spec ab und führt die übliche Verifikation, Review und Auslieferung aus.

Implement ist zum Delegieren von Arbeit, die du schon beschreiben kannst. Flow ist zum Entdecken.

## So beginnt ein Flow

Du musst Flow nicht beim Namen nennen. Beschreibst du etwas Exploratives oder Visuelles („ich will … ausprobieren“, „ich weiß nicht, wie es aussehen soll“), zeigt die Mission eine Karte mit zwei Wegen:

- **Flow** – jetzt gemeinsam bauen; die Spec kommt am Ende.
- **Spec + Implement** – zuerst eine Spec vereinbaren, dann an eine Rail delegieren.

Beide Wege sind gleich gewichtet und erscheinen immer in derselben Reihenfolge: Keiner wird empfohlen, du entscheidest. Unter **Warum der Agent fragt** sagt der Agent in einem Satz, was ihn zur Frage gebracht hat, und er besteht auf nichts – egal, welchen Weg du wählst oder ob du **Nicht jetzt** drückst.

Wählst du Flow, öffnet sich eine Bestätigung: Specrails erstellt einen isolierten Worktree, in dem der Agent Code schreiben kann; dein Hauptbranch bleibt unberührt. Drücke **Flow starten**. Auf dem Board erscheint eine vorläufige Spec mit dem Label **Im Flow** (ein Klick führt zurück zur Mission).

Kann dein Specrails Core Flow noch nicht ausführen, ist der Button deaktiviert und die Karte listet auf, was fehlt – meist hilft ein Update von Specrails Core.

## Während des Flows

Die Unterhaltung ändert ihr Aussehen (eine feine Akzentlinie am Rand), und über dem Eingabefeld erscheint eine Leiste:

- der **Branch** des Worktrees, die **geänderten Dateien** mit hinzugefügten und entfernten Zeilen und die **echten Kosten** des Flows bisher, wie vom Anbieter abgerechnet. Bis ein Turn gemeldete Kosten hat, steht dort `—` – nie eine Schätzung;
- ein Klick auf die **geänderten Dateien** listet jede Datei mit Status und +/−, ein Klick auf den **Branch** kopiert seinen Namen;
- **Pausieren** stoppt den Agenten und behält Worktree und Spec. Die Mission zeigt dann **Flow fortsetzen**;
- **Verwerfen**, links abgesetzt, löscht Worktree, Branch und vorläufige Spec. Die Bestätigung nennt, was verloren geht: die geänderten Dateien mit ihren +/−, den Branch und die Spec;
- **Fertig** – die Hauptaktion, siehe unten. Ist sie nicht verfügbar (der Flow speichert noch, eine andere Aktion läuft), sagt der Hinweis beim Darüberfahren, warum.

Du kannst schreiben, während der Agent arbeitet: Im Flow **unterbricht** deine Nachricht den aktuellen Schritt (der Senden-Button wird zum Blitz), und der Agent macht sofort mit deinen neuen Informationen weiter. Solange die Leiste sichtbar ist, tritt die Git-Leiste unter dem Eingabefeld zurück: Die Flow-Leiste zeigt den Branch des Worktrees bereits.

## Die App ausprobieren

Der Flow-Agent führt Typecheck und Tests selbst aus, um seine Arbeit zu prüfen. Gibt es etwas auszuprobieren, fragt er mit drei Optionen: **Start the app**, **Start and expose on the local network** oder **Not now**. Freigegeben kannst du die App von einem Smartphone im selben WLAN oder VPN öffnen, und jeder in diesem Netzwerk kann sie erreichen.

Sobald die App lauscht, nennt dir der Agent ihre Adressen als Links und die Flow-Leiste zeigt **Vorschau** mit einem grünen Punkt: Sie öffnet die App in deinem Browser. Ihr Menü enthält die Netzwerkadresse und **App beenden**. Die App läuft im Flow-Worktree, nie in deinem Haupt-Checkout, und Specrails beendet sie, wenn du den Flow pausierst, verwirfst oder übergibst.

## Fertig

Bist du mit dem Ergebnis zufrieden, drücke **Fertig**. Flow-Leiste und visuelle Hervorhebung verschwinden, und die gewohnte Rail-Startkarte erscheint – mit vorausgewähltem Loop **Flow → Spec** und einer freien Rail. Passe Engine, Modell oder Aufwand an, wenn du willst, und drücke **Starten**. Ist das Review-Limit oder ein Budget erreicht, sagt die Karte das und startet nicht. **Noch nicht** bringt dich zurück in den Flow.

Die Rail leitet aus dem Gebauten die Specrails-Spec und die OpenSpec-Änderung ab, verifiziert und prüft sie, und die Auslieferungskarte erscheint in der Mission wie bei jedem Lauf.

Über der Startkarte zeigt eine einzeilige Zusammenfassung, was an die Rail geht (Dateien und Zeilen), und die bisherigen Kosten des Flows. Scheitert der Lauf aus technischen Gründen, kehrt die Arbeit von selbst und unversehrt in diesen Flow zurück: Die Karte sagt in einfachen Worten, was fehlgeschlagen ist (die Codes stehen unter **Technische Details**), und der Agent erhält den Fehler und erklärt ihn. Verlangt die Prüfung Änderungen, bietet die Karte **Zurück zu Flow** oder **Neu starten** an. Ist die Auslieferung abgeschlossen, schließt die Mission den Flow mit einer Zusammenfassung ab: der Pull-Request, die aus dem Gebauten neu geschriebene Spec, die archivierte OpenSpec-Änderung und – falls vorhanden – der Jira-Vorgang.

## Gut zu wissen

- Flow schreibt nur in seinem Worktree. Außerhalb von Flow bleiben Missionen schreibgeschützt.
- Ein Flow pro Mission gleichzeitig. Eine Pause übersteht einen Neustart der App.
- Verschwindet der Worktree, wird der Flow als **muss geprüft werden** markiert, und nichts wird gelöscht.
- Jira erhält nichts, solange du im Flow bist oder wenn du ihn verwirfst.
- Die Flow-Kosten erscheinen in Analytics als eigene Fläche **Flow** und im Block der Agent-Missionen.
