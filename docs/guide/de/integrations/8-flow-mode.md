# Flow: erst bauen, dann die Spec

Flow ist eine Art, mit einem Agenten zu bauen, wenn du noch nicht genau weißt, was du willst. Du sprichst in deiner Mission mit dem Agenten, er schreibt und startet echten Code auf seinem eigenen Flow-Branch (einer separaten Kopie deines Projekts), und wenn das Ergebnis stimmt, drückst du **Übergeben**: Ein Rail übernimmt deine Änderungen, leitet die Spec ab und führt die übliche Prüfung, Review und Auslieferung aus.

Implement ist zum Delegieren von Arbeit, die du schon beschreiben kannst. Flow ist zum Entdecken.

## So beginnt ein Flow

Du musst Flow nie beim Namen nennen. Wenn du etwas Exploratives oder Visuelles beschreibst („Ich will ausprobieren…“, „Ich weiß nicht, wie es aussehen soll“), zeigt die Mission eine Karte mit zwei Wegen:

- **Flow**: jetzt gemeinsam bauen; die Spec kommt am Ende.
- **Spec + Implement**: erst eine Spec vereinbaren, dann an einen Rail delegieren.

Beide Wege haben dasselbe Gewicht und erscheinen immer in derselben Reihenfolge: Keiner wird empfohlen, du entscheidest. Unter **Warum der Agent fragt** sagt der Agent in einem Satz, warum er fragt, und er drängt nicht, egal welchen Weg du wählst oder ob du **Nicht jetzt** drückst.

Wählst du Flow, öffnet sich eine Bestätigung: Specrails legt eine separate Kopie des Projekts auf einem eigenen Flow-Branch an, in der der Agent Code schreiben kann, und dein Hauptbranch bleibt unberührt. Drücke **Flow starten**. Auf dem Board erscheint eine Platzhalter-Spec mit dem Label **Im Flow** (ein Klick führt zurück zur Mission).

Kann dein Specrails Core Flow noch nicht ausführen, ist Starten deaktiviert und die Karte nennt, was fehlt. Meist hilft ein Update von Specrails Core.

## Während des Flows

Der Flow-Modus wird dort benannt, wo du hinschaust, in seiner eigenen Flow-Farbe: Der Composer zeigt einen **Flow**-Chip neben dem Autonomie-Chip, eine feine Linie am oberen Rand und den Hinweis *Sag dem Agenten, was er in diesem Flow ändern soll…*; der Missionstitel zeigt **Im Flow**, ebenso ihre Zeile in der Missionsliste. Das Gespräch markiert, wo du Flow betreten und verlassen hast, und die im Flow geschriebenen Antworten des Agenten tragen neben ihrer Uhrzeit eine kleine **Flow**-Marke.

Die Leiste direkt über dem Composer zeigt den Flow in einer kurzen Zeile: seinen Status, **Flow · 7 Dateien**, **Pausieren** und die Hauptaktion **Übergeben**. Ist eine Aktion nicht verfügbar (der Flow speichert noch, eine andere Aktion läuft), sagt der Hover-Text warum. Öffne die Zeile mit ihrem Pfeil, wie jeden anderen Lauf, um den Rest zu sehen:

- den **Branch** (Klick kopiert den Namen), die **Änderungen** mit hinzugefügten und entfernten Zeilen (Klick listet jede geänderte Datei mit Status und +/−) und die **Kosten bisher**, wie vom Anbieter abgerechnet. Bis ein Zug gemeldete Kosten hat, steht dort `—`, nie eine Schätzung; ein `*` markiert eine Summe ohne unbepreiste Züge, mit einem Hinweis, wie viele es sind;
- **Vorschau**, solange die App des Flows läuft (siehe unten);
- **Verwerfen**, abgesetzt, löscht die Änderungen des Flows, seinen Branch und die Platzhalter-Spec. Die Bestätigung listet, was verloren geht: die geänderten Dateien mit ihren +/−, den Branch und die Spec.

**Pausieren** stoppt den Agenten und behält deine Änderungen und die Spec. Die Zeile zeigt dann **Flow fortsetzen**.

Du kannst schreiben, während der Agent arbeitet: Im Flow **unterbricht** deine Nachricht den aktuellen Schritt (der Senden-Knopf wird zum Blitz), und der Agent macht sofort mit deinen neuen Informationen weiter. Solange der Flow offen ist, tritt die Git-Leiste unter dem Composer zur Seite: Das Panel des Flows zeigt seinen Branch bereits.

## Die App ausprobieren

Der Flow-Agent führt Typecheck und Tests selbst aus, um seine Arbeit zu prüfen. Gibt es etwas auszuprobieren, fragt er mit drei Optionen: **Start the app**, **Start and expose on the local network** oder **Not now**. Freigeben erlaubt dir, die App von einem Handy im selben WLAN oder VPN zu öffnen, und jeder in diesem Netz kann sie erreichen.

Sobald die App lauscht, gibt dir der Agent ihre Adressen als Links, und das Panel des Flows zeigt **Vorschau** mit einem grünen Punkt: Sie öffnet die App in deinem Browser. Ihr Menü hat die Netzwerkadresse und **App beenden**. Die App läuft aus der Kopie des Flows, nie aus deinem Haupt-Checkout, und Specrails beendet sie, wenn du den Flow pausierst, verwirfst oder übergibst.

## Übergeben

Wenn dir das Ergebnis gefällt, drücke **Übergeben**. Die Zeile zeigt **Bereit, ein PR zu werden** und öffnet darüber eine einzige Zeile: *Rail 2 macht aus deinen 7 geänderten Dateien einen geprüften PR. Wenn etwas schiefgeht, bleibt deine Arbeit erhalten.* Drücke **Starten** oder **Noch nicht**, um zum Flow zurückzukehren.

Rail, Engine, Modell und Aufwand sind schon für dich gewählt (ein freier Rail und die Engine deines Gesprächs). Um sie zu ändern, öffne **Wie ändern**; dort siehst du auch, was sich geändert hat, und die Kosten bisher. Während die Übergabe startet, zeigt die Leiste den Start ohne Lücke und folgt dann dem Lauf Schritt für Schritt. Ist das Review-Limit oder ein Budget erreicht, sagt die Zeile das, und nichts startet. Das **Starten** der Leiste selbst startet nie von allein: Es holt die Zeile mit dem Fokus auf Starten zurück, damit du immer dort bestätigst.

Der Rail leitet aus dem Gebauten die Spec und ihre Spec-Änderung ab, prüft und reviewt sie, und die Auslieferungskarte erscheint in der Mission wie bei jedem Lauf.

Scheitert der Lauf aus technischem Grund, kommt die Arbeit von selbst unversehrt in diesen Flow zurück: Die Karte sagt in einfachen Worten, was fehlschlug (die Codes bleiben unter **Technische Details**), und der Agent erhält den Fehler und erklärt ihn. Verlangt die Review Änderungen, bietet die Karte **Zurück zu Flow** oder **Neu starten**. Ist die Auslieferung abgeschlossen, schließt die Mission den Flow mit einer Zusammenfassung: der Pull Request, die aus dem Gebauten neu geschriebene Spec, die archivierte Spec-Änderung und das Jira-Issue, falls vorhanden.

## Gut zu wissen

- Flow schreibt nur auf seinem eigenen Branch. Außerhalb von Flow bleiben Missionen schreibgeschützt.
- Ein Flow pro Mission zur gleichen Zeit. Eine Pause übersteht einen Neustart der App.
- Verschwindet die Projektkopie des Flows, wird der Flow als **muss geprüft werden** markiert (zur Info, nichts zu entscheiden), und nichts wird gelöscht.
- Die Leiste wechselt nie den Lauf, den du gerade ansiehst. Braucht dich inzwischen ein anderer Lauf, sagt sein Name im Umschalter der Leiste **braucht dich**.
- Jira erhält nichts, solange du im Flow bist oder wenn du ihn verwirfst.
- Flow-Kosten erscheinen in der Analyse als eigene Oberfläche, **Flow**, und im Block der Agenten-Missionen.
