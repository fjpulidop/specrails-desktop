# Flow: erst bauen, dann die Spec

Mit Flow baust du gemeinsam mit einem Agenten, wenn du noch nicht genau weißt, was du willst. Du sprichst in deiner Mission mit dem Agenten, er schreibt und startet echten Code in einem isolierten Worktree, und wenn das Ergebnis passt, sagst du **Das ist es**: Eine Rail übernimmt den Worktree, leitet die Spec ab und führt die übliche Verifikation, Review und Auslieferung aus.

Implement ist zum Delegieren von Arbeit, die du schon beschreiben kannst. Flow ist zum Entdecken.

## So beginnt ein Flow

Du musst Flow nicht beim Namen nennen. Beschreibst du etwas Exploratives oder Visuelles („ich will … ausprobieren“, „ich weiß nicht, wie es aussehen soll“), zeigt die Mission eine Karte mit zwei Wegen:

- **Flow** – jetzt gemeinsam bauen; die Spec kommt am Ende.
- **Spec + Implement** – zuerst eine Spec vereinbaren, dann an eine Rail delegieren.

Die Karte markiert den empfohlenen Weg und begründet ihn in einem Satz. Der andere Weg ist immer einen Klick entfernt, und der Agent besteht nicht darauf, wenn du ihn wählst oder **Nicht jetzt** drückst.

Wählst du Flow, öffnet sich eine Bestätigung: Specrails erstellt einen isolierten Worktree, in dem der Agent Code schreiben kann; dein Hauptbranch bleibt unberührt. Drücke **Flow starten**. Auf dem Board erscheint eine vorläufige Spec mit dem Label **Im Flow** (ein Klick führt zurück zur Mission).

Kann dein Specrails Core Flow noch nicht ausführen, ist der Button deaktiviert und die Karte listet auf, was fehlt – meist hilft ein Update von Specrails Core.

## Während des Flows

Die Unterhaltung ändert ihr Aussehen (eine feine Akzentlinie am Rand), und über dem Eingabefeld erscheint eine Leiste:

- der **Branch** des Worktrees, die **geänderten Dateien** mit hinzugefügten und entfernten Zeilen und die **echten Kosten** des Flows bisher, wie vom Anbieter abgerechnet. Bis ein Turn gemeldete Kosten hat, steht dort `—` – nie eine Schätzung;
- **Änderungen ansehen** listet jede geänderte Datei mit Status und +/−;
- **Pausieren** stoppt den Agenten und behält Worktree und Spec. Die Mission zeigt dann **Flow fortsetzen**;
- **Verwerfen** löscht nach einer Bestätigung Worktree, Branch und vorläufige Spec;
- **Das ist es** – die Hauptaktion, siehe unten.

Du kannst schreiben, während der Agent arbeitet: Im Flow **unterbricht** deine Nachricht den aktuellen Schritt (der Senden-Button wird zum Blitz), und der Agent macht sofort mit deinen neuen Informationen weiter. Die Git-Leiste unter dem Eingabefeld zeigt den Branch des Worktrees.

## Die App ausprobieren

Der Flow-Agent führt Typecheck und Tests selbst aus, um seine Arbeit zu prüfen. Gibt es etwas auszuprobieren, fragt er mit drei Optionen: **Start the app**, **Start and expose on the local network** oder **Not now**. Freigegeben kannst du die App von einem Smartphone im selben WLAN oder VPN öffnen, und jeder in diesem Netzwerk kann sie erreichen.

Sobald die App lauscht, nennt dir der Agent ihre Adressen als Links und die Flow-Leiste zeigt **Vorschau** mit einem grünen Punkt: Sie öffnet die App in deinem Browser. Ihr Menü enthält die Netzwerkadresse und **App beenden**. Die App läuft im Flow-Worktree, nie in deinem Haupt-Checkout, und Specrails beendet sie, wenn du den Flow pausierst, verwirfst oder übergibst.

## Das ist es

Bist du mit dem Ergebnis zufrieden, drücke **Das ist es**. Flow-Leiste und visuelle Hervorhebung verschwinden, und die gewohnte Rail-Startkarte erscheint – mit vorausgewähltem Loop **Flow → Spec** und einer freien Rail. Passe Engine, Modell oder Aufwand an, wenn du willst, und drücke **Starten**. Ist das Review-Limit oder ein Budget erreicht, sagt die Karte das und startet nicht. **Noch nicht** bringt dich zurück in den Flow.

Die Rail leitet aus dem Gebauten die Specrails-Spec und die OpenSpec-Änderung ab, verifiziert und prüft sie, und die Auslieferungskarte erscheint in der Mission wie bei jedem Lauf.

## Gut zu wissen

- Flow schreibt nur in seinem Worktree. Außerhalb von Flow bleiben Missionen schreibgeschützt.
- Ein Flow pro Mission gleichzeitig. Eine Pause übersteht einen Neustart der App.
- Verschwindet der Worktree, wird der Flow als **muss geprüft werden** markiert, und nichts wird gelöscht.
- Jira erhält nichts, solange du im Flow bist oder wenn du ihn verwirfst.
- Die Flow-Kosten erscheinen in Analytics als eigene Fläche **Flow** und im Block der Agent-Missionen.
