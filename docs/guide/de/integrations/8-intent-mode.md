# Intent: erst bauen, dann die Spec {#intent-mode}

Intent ist eine Art, mit einem Agenten zu bauen, wenn du noch nicht genau weißt, was du willst. Du sprichst in deiner Mission mit dem Agenten, er schreibt und startet echten Code auf seinem eigenen Intent-Branch (einer separaten Kopie deines Projekts), und wenn das Ergebnis stimmt, drückst du **Übergeben**: Ein Rail übernimmt deine Änderungen, leitet die Spec ab und führt die übliche Prüfung, Review und Auslieferung aus.

Implement ist zum Delegieren von Arbeit, die du schon beschreiben kannst. Intent ist zum Entdecken.

## So beginnt ein Intent

Du musst Intent nie beim Namen nennen. Wenn du etwas Exploratives oder Visuelles beschreibst („Ich will ausprobieren…“, „Ich weiß nicht, wie es aussehen soll“), zeigt die Mission eine Karte mit zwei Wegen:

- **Intent**: jetzt gemeinsam bauen; die Spec kommt am Ende.
- **Spec + Implement**: erst eine Spec vereinbaren, dann an einen Rail delegieren.

Beide Wege haben dasselbe Gewicht und erscheinen immer in derselben Reihenfolge: Keiner wird empfohlen, du entscheidest. Unter **Warum der Agent fragt** sagt der Agent in einem Satz, warum er fragt, und er drängt nicht, egal welchen Weg du wählst oder ob du **Nicht jetzt** drückst.

Wählst du Intent, öffnet sich eine Bestätigung: Specrails legt eine separate Kopie des Projekts auf einem eigenen Intent-Branch an, in der der Agent Code schreiben kann, und dein Hauptbranch bleibt unberührt. Drücke **Intent starten**. Auf dem Board erscheint eine Platzhalter-Spec mit dem Label **Im Intent** (ein Klick führt zurück zur Mission).

Kann dein Specrails Core Intent noch nicht ausführen, ist Starten deaktiviert und die Karte nennt, was fehlt. Meist hilft ein Update von Specrails Core.

## Einen Intent aus einer vorhandenen Spec starten

Jede Spec lässt sich in Intent bauen, nicht nur eine neue Idee. Intent und Implement bleiben zwei gleichwertige Wege, daran zu arbeiten:

- auf dem Board: Rechtsklick auf eine Spec und **In Intent starten** (neben dem Ziehen auf eine Rail); in der Spec-Detailansicht steht **In Intent starten** neben **Auf Rail verschieben**;
- in einer Mission: Wenn du eine Spec umsetzen lassen willst, ohne eine Rail zu nennen, zeigt der Agent dieselbe Karte mit zwei Wegen für diese Spec: **Intent** arbeitet mit dir daran, **Spec + Implement** startet sie auf einer Rail;
- eine Rail-Startkarte für eine einzelne Spec bietet ebenfalls **In Intent starten** neben ihrem Start an.

Die Spec selbst ist dann **In Intent**: Es entsteht keine Platzhalter-Spec, und der erste Zug des Agenten erhält die Spec (Akzeptanzkriterien, Contract Layer, Nicht-Ziele und offene Addenda). Vom Board aus gestartet, öffnet sich der Intent in der Mission der Spec oder in einer neuen Mission mit dem Namen der Spec. In einem Projekt mit mehreren Git-Repositorys fragt ein kleiner Dialog zuerst, wo der Intent läuft, wenn die Spec nicht genau eines davon nennt: Es werden nur die Git-Repositorys angezeigt, das Repository der Spec (sonst das primäre) ist vorausgewählt, und die Pfeiltasten ändern die Auswahl. **In Intent starten** ist deaktiviert, mit dem Grund im Tooltip, wenn die Spec schon in Intent ist, erledigt oder abgebrochen ist, auf einer Rail liegt oder Intent nicht verfügbar ist.

**Verwerfen** gibt die Spec genau so zurück, wie sie war, mit ihrem vorherigen Status: Deine Spec wird nie gelöscht. Wird der Intent geliefert, wird die Spec aus dem Gebauten neu geschrieben; vorher bleibt ihr ursprünglicher Text als Kommentar **Original spec before Intent** erhalten, damit nichts verloren geht. Eine bereits mit Jira verknüpfte Spec aktualisiert genau dieses Issue und verschiebt es in den für Review zugeordneten Status; es entsteht kein zweites Issue.

## Während des Flows

Der Intent-Modus wird dort benannt, wo du hinschaust, in seiner eigenen Intent-Farbe: Der Composer zeigt einen **Intent**-Chip neben dem Autonomie-Chip und den Hinweis *Sag dem Agenten, was er in diesem Intent ändern soll…*; der Missionstitel zeigt **Im Intent**, ebenso ihre Zeile in der Missionsliste. Das Gespräch markiert, wo du Intent betreten und verlassen hast, und die im Intent geschriebenen Antworten des Agenten tragen neben ihrer Uhrzeit eine kleine **Intent**-Marke.

Die Leiste direkt über dem Composer zeigt den Intent in einer kurzen Zeile: seinen Status, **Intent · 7 Dateien**, **Intent pausieren** und die Hauptaktion **Übergeben**. Ist eine Aktion nicht verfügbar (der Intent speichert noch, eine andere Aktion läuft), sagt der Hover-Text warum. Öffne die Zeile mit ihrem Pfeil, wie jeden anderen Lauf, um den Rest zu sehen:

- den **Branch** (Klick kopiert den Namen), die **Änderungen** mit hinzugefügten und entfernten Zeilen (Klick listet jede geänderte Datei mit Status und +/−) und die **Kosten bisher**, wie vom Anbieter abgerechnet. Bis ein Zug gemeldete Kosten hat, steht dort `—`, nie eine Schätzung; ein `*` markiert eine Summe ohne unbepreiste Züge, mit einem Hinweis, wie viele es sind;
- **Vorschau**, solange die App des Flows läuft (siehe unten);
- **Verwerfen**, abgesetzt, löscht die Änderungen des Flows, seinen Branch und die Platzhalter-Spec. Die Bestätigung listet, was verloren geht: die geänderten Dateien mit ihren +/−, den Branch und die Spec.

**Intent pausieren** stoppt den Agenten und behält deine Änderungen und die Spec. Die Zeile zeigt dann **Intent fortsetzen**.

Du kannst schreiben, während der Agent arbeitet: Im Intent **unterbricht** deine Nachricht den aktuellen Schritt (der Senden-Knopf wird zum Blitz), und der Agent macht sofort mit deinen neuen Informationen weiter. Solange der Intent offen ist, tritt die Git-Leiste unter dem Composer zur Seite: Das Panel des Flows zeigt seinen Branch bereits.

## Die App ausprobieren

Der Intent-Agent führt Typecheck und Tests selbst aus, um seine Arbeit zu prüfen. Gibt es etwas auszuprobieren, fragt er mit drei Optionen: **Start the app**, **Start and expose on the local network** oder **Not now**. Freigeben erlaubt dir, die App von einem Handy im selben WLAN oder VPN zu öffnen, und jeder in diesem Netz kann sie erreichen.

Sobald die App lauscht, gibt dir der Agent ihre Adressen als Links, und das Panel des Flows zeigt **Vorschau** mit einem grünen Punkt: Sie öffnet die App in deinem Browser. Ihr Menü hat die Netzwerkadresse und **App beenden**. Die App läuft aus der Kopie des Flows, nie aus deinem Haupt-Checkout, und Specrails beendet sie, wenn du den Intent pausierst, verwirfst oder übergibst.

## Übergeben {#intent-hand-off}

Wenn dir das Ergebnis gefällt, drücke **Übergeben**. Die Zeile zeigt **Bereit, ein PR zu werden** und öffnet darüber eine einzige Zeile: *Rail 2 macht aus deinen 7 geänderten Dateien einen geprüften PR. Wenn etwas schiefgeht, bleibt deine Arbeit erhalten.* Drücke **Starten** oder **Noch nicht**, um zum Intent zurückzukehren; **Esc** ist dasselbe wie **Noch nicht**; ein Klick daneben klappt die Zeile nur ein, und die Zeile bleibt bei **Bereit, ein PR zu werden** mit **Starten**. Kann die Engine deines Gesprächs die Übergabe auf diesem Rechner nicht ausführen, sagt das ein Hinweis direkt unter der Zeile, und die Standard-Engine des Rails wird verwendet.

Rail, Engine, Modell und Aufwand sind schon für dich gewählt (ein freier Rail und die Engine deines Gesprächs). Um sie zu ändern, öffne **Vorgehen ändern**; dort siehst du auch, was sich geändert hat. Die Kosten bisher stehen in der Hauptzeile. Deine Auswahl bleibt erhalten, wenn du **Noch nicht** drückst und später erneut übergibst. Während die Übergabe startet, zeigt die Leiste den Start ohne Lücke und folgt dann dem Lauf Schritt für Schritt. Ist das Review-Limit oder ein Budget erreicht, sagt die Zeile das, und nichts startet. Zeigt sich der Lauf nach 45 Sekunden noch nicht, hört die Leiste auf zu drehen und zeigt **Wird noch an Rail 2 übergeben…** mit **Aktualisieren**, das erneut nachsieht und weiter wartet, bis der Lauf erscheint.

Der Rail leitet aus dem Gebauten die Spec und ihre Spec-Änderung ab, prüft und reviewt sie, und die Auslieferungskarte erscheint in der Mission wie bei jedem Lauf.

Scheitert der Lauf aus technischem Grund, kommt die Arbeit von selbst unversehrt in diesen Intent zurück: Die Karte sagt in einfachen Worten, was fehlschlug (die Codes bleiben unter **Technische Details**), und der Agent erhält den Fehler und erklärt ihn. Verlangt die Review Änderungen, bietet die Karte **Zurück zum Intent** oder **Neu starten**. Ist die Auslieferung abgeschlossen, schließt die Mission den Intent mit einer Zusammenfassung: der Pull Request, die aus dem Gebauten neu geschriebene Spec, die archivierte Spec-Änderung und der Jira-Vorgang, falls vorhanden.

## Gut zu wissen

- Intent schreibt nur auf seinem eigenen Branch. Außerhalb von Intent bleiben Missionen schreibgeschützt.
- Ein Intent pro Mission zur gleichen Zeit. Eine Pause übersteht einen Neustart der App.
- Verschwindet die Projektkopie des Flows, wird der Intent als **muss geprüft werden** markiert (zur Info, nichts zu entscheiden), und nichts wird gelöscht.
- Die Leiste wechselt nie den Lauf, den du gerade ansiehst. Braucht dich inzwischen ein anderer Lauf, sagt sein Name im Umschalter der Leiste **braucht dich**.
- Jira erhält nichts, solange du im Intent bist oder wenn du ihn verwirfst.
- Intent-Kosten erscheinen in der Analyse als eigene Oberfläche, **Intent**, und im Block der Agenten-Missionen.
