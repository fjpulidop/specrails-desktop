# Intent: Sag das Problem, nicht die Lösung {#intent-mode}

Code zu schreiben ist nicht mehr der langsame Teil beim Entwickeln von Software. Langsam ist es, zu wissen, was gebaut werden soll, und zu prüfen, dass es richtig gebaut wurde. Genau hier setzt Intent an. Du schreibst den **Intent** auf: das Problem, das Ergebnis, das du willst, woran du erkennst, dass es funktioniert hat, wen und was es betrifft, die Grenzen und was noch niemand weiß. Die Lösung schreibst du nicht. Specrails leitet die Spec aus deinem Intent ab, und du prüfst die Spec, statt sie zu schreiben.

Von einem Intent aus gibt es zwei gleichwertige Wege:

- **Erkunden**: Baue es gemeinsam mit einem Agenten in einer isolierten Intent-Sitzung (mit eigenem Branch, einer separaten Kopie deines Projekts). Wenn das Ergebnis stimmt, leitet ein Rail die Spec aus dem ab, was du gebaut hast.
- **Delegieren**: Der Agent schreibt die Spec aus dem Intent, du prüfst sie, und ein Rail baut sie.

Erkunden ist zum Entdecken da; Delegieren zum Bauen dessen, was schon klar ist. Keiner der Wege wird empfohlen: Du entscheidest.

## Der Intent

Ein Intent hat sechs Teile, und keinen für die Lösung:

| Teil | Was hineingehört |
| --- | --- |
| **Problem** | Was heute nicht stimmt, für wen und wann es weh tut. |
| **Angestrebtes Ergebnis** | Was gilt, wenn es gelöst ist. Eine optionale **Hypothese** lautet *Wir glauben, dass … zu … führt; wir wissen es, wenn …*. |
| **Woran wir es erkennen** | Beobachtbare Signale dafür, dass das Ergebnis eingetreten ist („Ein neuer Nutzer schließt die Einrichtung in unter 2 Minuten ab“). Sie werden zu Akzeptanzkriterien. |
| **Wen und was es betrifft** | Personen, Bildschirme oder Systeme. |
| **Rahmenbedingungen** | Grenzen, die jede Lösung einhalten muss. |
| **Offene Fragen** | Was noch niemand weiß. Agenten untersuchen sie, statt zu raten. |

Nennst du eine Lösung („Redis-Cache hinzufügen“), behält der Intent ihren Zweck („Die API antwortet in unter 200 ms“) als angestrebtes Ergebnis, und deine Lösung wird zur Rahmenbedingung (du verlangst sie) oder zur offenen Frage (sie ist eine Option).

Jede Spec kann einen Intent tragen. Er steht in der Spec-Detailansicht über der Beschreibung, und du kannst jeden Teil dort bearbeiten; eine Spec ohne Intent zeigt eine kompakte Aktion **Intent hinzufügen**. Während du bearbeitest, ist **Intent speichern** der Hauptknopf, **Esc** bricht ab und **⌘/Ctrl+Enter** speichert. Jede beantwortete offene Frage zeigt ihre Antwort unter der Beschriftung **Antwort**, und sobald keine mehr offen ist, lautet die Überschrift **Fragen · N beantwortet**. Eine Spec, deren Intent noch offene Fragen hat, zeigt auf dem Board einen kleinen Kompass mit ihrer Anzahl, in jeder Board-Ansicht (Post-it oder Zeile). Der Intent bleibt in Specrails, wie **Nicht-Ziele**, und wird nie nach Jira geschrieben.

## Woher ein Intent kommt

- **In einer Mission (Standard).** Wenn du Arbeit beschreibst, befragt dich der Agent wie ein Analyst. Er fragt nach den Nutzern, den Grenzen und danach, woran du erkennst, dass es funktioniert hat, und zeigt eine **Intent**-Karte mit allen Teilen und zwei Lesarten deiner Anfrage. Klicke auf eine Lesart, um zu antworten, oder antworte mit eigenen Worten. Solange der Intent nicht abgestimmt ist, ist jede offene Frage auf der Karte ein Knopf, der deine Antwort im Composer vorausfüllt, und ein Pill sagt, wie viele noch offen sind. Ist er abgestimmt, zeigt das Pill **Abgestimmt**, die Lesarten weichen **Lesart bestätigt**, und die Karte bietet **Erkunden** und **Delegieren** nebeneinander unter **Wie möchtest du weitermachen?** an; die beiden Wege bleiben über deine eigenen Folgenachrichten hinweg auf der Karte, und ein langer Intent wird mit **Ganzen Intent anzeigen** eingeklappt. Der Chip **Mit einem Problem beginnen** auf der Missions-Startseite startet dieses Interview. Eine Spec, die der Agent daraus schreibt, trägt den Intent automatisch. Um den Intent-Schritt für eine Mission zu überspringen, sende `#noframe`; `#frame` schaltet ihn wieder ein.
- **In Spec hinzufügen.** **Intent** ist der erste Modus und öffnet sich standardmäßig (markiert als **Standard**). Beschreibe das Problem, nicht die Lösung; drei Chips über dem Editor, **Problem**, **Wen es betrifft** und **Woran wir es erkennen**, fügen eine Zeile zum Ausfüllen ein (*Problem:*, *Wen es betrifft:*, *Wir wissen, dass es funktioniert hat, wenn:*). Drücke **Intent und Spec schreiben**: Ein einziger KI-Durchlauf schreibt den Intent und danach die daraus abgeleitete Spec, bereit für deine Prüfung. Quick, Explore und Raw gibt es weiterhin. Lässt sich der Intent nicht schreiben, bekommst du trotzdem die Spec, ohne Intent, und ein Hinweis sagt es dir; scheitert die Erzeugung, bleibt dein Text im Editor. Eine **Raw**-Spec bekommt jetzt keinen Intent: Du kannst ihn später aus der Spec heraus hinzufügen.

## Der Intent reist mit der Arbeit

- Jeder Agent, der an der Spec arbeitet, erhält zuerst den Intent, gekennzeichnet als Quelle der Wahrheit für das *Warum* und das *angestrebte Ergebnis*, nie für das *Wie*. Das gilt für den Planer, den Entwickler, den Reviewer und den Agenten der Intent-Sitzung. Der Reviewer beurteilt die Arbeit außerdem am angestrebten Ergebnis und an den Signalen.
- Liefert ein Rail eine Spec mit Intent aus, schreibt Specrails ihn als `intent.md` in die OpenSpec-Änderung des Laufs, neben Proposal, Design und Tasks. So liegt der Intent mit dem Code in Git. (Ein Batch-Lauf über mehrere Specs schreibt keinen.)

## Erkunden: eine Intent-Sitzung starten

Wähle **Erkunden** auf einer Karte mit abgestimmtem Intent. Es öffnet sich eine Bestätigung, **Mit dem Agenten erkunden**: Specrails legt eine separate Kopie des Projekts auf einem eigenen Intent-Branch an, in der der Agent Code schreiben kann, und dein Hauptbranch bleibt unberührt. Drücke **Erkundung starten**. Auf dem Board erscheint eine Platzhalter-Spec mit deinem Intent und dem Label **Im Intent** (ein Klick führt zurück zur Mission), und der erste Zug des Agenten beginnt beim Intent.

## Einen Intent aus einer vorhandenen Spec starten

Jede Spec lässt sich in Intent bauen, nicht nur eine neue Idee. Intent und Implement bleiben zwei gleichwertige Wege, daran zu arbeiten:

- auf dem Board: Rechtsklick auf eine Spec und **Mit dem Agenten erkunden** (neben dem Ziehen auf eine Rail); in der Spec-Detailansicht steht **Mit dem Agenten erkunden** neben **Auf Rail verschieben**;
- in einer Mission: Wenn du eine Spec umsetzen lassen willst, ohne eine Rail zu nennen, zeigt der Agent eine Karte mit zwei Wegen für diese Spec unter **Wie möchtest du weitermachen?**: **Erkunden** arbeitet mit dir daran, **Delegieren** startet sie auf einer Rail;
- eine Rail-Startkarte für eine einzelne Spec bietet ebenfalls **Mit dem Agenten erkunden** neben ihrem Start an.

Alle drei Türen öffnen zuerst dieselbe Bestätigung: den Titel der Spec, eine Zusammenfassung ihres Intents, die Engine, die arbeiten wird, und, nur in einem Projekt mit mehreren Git-Repositorys, eine Auswahl **Repository** (nur Git-Repositorys; das Repository der Spec, sonst das primäre, ist vorausgewählt; die Pfeiltasten ändern die Auswahl). Nichts startet, bevor du **Erkundung starten** drückst; **Abbrechen** lässt die Spec, wie sie war. Aus dem Board-Menü öffnet sich die Spec-Detailansicht mit dieser Bestätigung obenauf. Startet der Intent, kommt die Mission nach vorn, und ein Toast zeigt **Spec #N wird auf <branch> erkundet** mit **Intent-Mission öffnen**. Der Intent-Branch wird nach der Spec in ganzen Wörtern benannt, bis zu 48 Zeichen, nie mitten im Wort abgeschnitten (`feat/1-alta-sin-clave-de-api-proyecto`).

Die Spec selbst ist dann **Im Intent**: Es entsteht keine Platzhalter-Spec, und der erste Zug des Agenten erhält die Spec (zuerst ihr Intent, dann Akzeptanzkriterien, Contract Layer, Nicht-Ziele und offene Addenda). Vom Board aus gestartet, öffnet sich der Intent in der Mission der Spec oder in einer neuen Mission mit dem Namen der Spec. Eine Spec, die schon im Intent ist, bietet stattdessen **Intent-Mission öffnen** an, und die Post-it-Karte bietet **Auf Rail verschieben** nicht mehr an. **Mit dem Agenten erkunden** ist deaktiviert, mit dem Grund im Tooltip, wenn die Spec erledigt oder abgebrochen ist, auf einer Rail liegt oder Intent nicht verfügbar ist.

**Verwerfen** gibt die Spec genau so zurück, wie sie war, mit ihrem vorherigen Status: Deine Spec wird nie gelöscht. Wird der Intent geliefert, wird die Spec aus dem Gebauten neu geschrieben; vorher bleibt ihr ursprünglicher Text als Kommentar **Original spec before Intent** erhalten, damit nichts verloren geht. Der Intent selbst wird nie umgeschrieben: Nur seine offenen Fragen erhalten die Antworten, die die Arbeit geklärt hat. Eine bereits mit Jira verknüpfte Spec aktualisiert genau dieses Issue und verschiebt es in den für Review zugeordneten Status; es entsteht kein zweites Issue.

## Während des Flows

Der Intent-Modus wird dort benannt, wo du hinschaust, in seiner eigenen Intent-Farbe: Der Composer zeigt einen **Intent**-Chip neben dem Autonomie-Chip und den Hinweis *Sag dem Agenten, was er in diesem Intent ändern soll…*; der Missionstitel zeigt **Im Intent**, ebenso ihre Zeile in der Missionsliste. Das Gespräch markiert, wo du Intent betreten und verlassen hast, und die im Intent geschriebenen Antworten des Agenten tragen neben ihrer Uhrzeit eine kleine **Intent**-Marke.

Die Leiste direkt über dem Composer zeigt den Intent in einer kurzen Zeile: seinen Status, **Erkundung · 7 Dateien**, **Pausieren** und **Übergeben**. **Übergeben** ist immer da und wird zur gefüllten Hauptaktion, sobald sich Dateien auf dem Intent-Branch geändert haben; davor kann der Rail die Spec noch aus deinem Gespräch ableiten. Ist eine Aktion nicht verfügbar (der Intent speichert noch, eine andere Aktion läuft), sagt der Hover-Text warum. Öffne die Zeile mit ihrem Pfeil, wie jeden anderen Lauf, um den Rest zu sehen:

- den **Branch** (Klick kopiert den Namen), die **Änderungen** mit hinzugefügten und entfernten Zeilen (Klick listet jede geänderte Datei mit Status und +/−) und die **Kosten bisher**, wie vom Anbieter abgerechnet. Bis ein Zug gemeldete Kosten hat, steht dort `—`, nie eine Schätzung; ein `*` markiert eine Summe ohne unbepreiste Züge, mit einem Hinweis, wie viele es sind;
- **Vorschau**, solange die App des Flows läuft (siehe unten);
- **Verwerfen**, abgesetzt, löscht die Änderungen des Flows, seinen Branch und die Platzhalter-Spec. Die Bestätigung listet, was verloren geht: die geänderten Dateien mit ihren +/−, den Branch und die Spec.

**Pausieren** stoppt den Agenten und behält deine Änderungen und die Spec. Die Zeile zeigt dann **Fortsetzen**.

Du kannst schreiben, während der Agent arbeitet: Im Intent **unterbricht** deine Nachricht den aktuellen Schritt (der Senden-Knopf wird zum Blitz), und der Agent macht sofort mit deinen neuen Informationen weiter. Solange der Intent offen ist, tritt die Git-Leiste unter dem Composer zur Seite: Das Panel des Flows zeigt seinen Branch bereits.

## Die App ausprobieren

Der Intent-Agent führt Typecheck und Tests selbst aus, um seine Arbeit zu prüfen. Gibt es etwas auszuprobieren, fragt er mit drei Optionen: **Start the app**, **Start and expose on the local network** oder **Not now**. Freigeben erlaubt dir, die App von einem Handy im selben WLAN oder VPN zu öffnen, und jeder in diesem Netz kann sie erreichen.

Sobald die App lauscht, gibt dir der Agent ihre Adressen als Links, und das Panel des Flows zeigt **Vorschau** mit einem grünen Punkt: Sie öffnet die App in deinem Browser. Ihr Menü hat die Netzwerkadresse und **App beenden**. Die App läuft aus der Kopie des Flows, nie aus deinem Haupt-Checkout, und Specrails beendet sie, wenn du den Intent pausierst, verwirfst oder übergibst.

## Übergeben {#intent-hand-off}

Wenn dir das Ergebnis gefällt, drücke **Übergeben**. Die Zeile zeigt **Bereit, ein PR zu werden** und öffnet darüber eine einzige Zeile: *Rail 2 macht aus deinen 7 geänderten Dateien einen geprüften PR. Wenn etwas schiefgeht, bleibt deine Arbeit erhalten.* Drücke **Starten** oder **Noch nicht**, um zum Intent zurückzukehren; **Esc** ist dasselbe wie **Noch nicht**; ein Klick daneben klappt die Zeile nur ein, und die Zeile bleibt bei **Bereit, ein PR zu werden** mit **Starten**. Kann die Engine deines Gesprächs die Übergabe auf diesem Rechner nicht ausführen, sagt das ein Hinweis direkt unter der Zeile, und die Standard-Engine des Rails wird verwendet.

Rail, Engine, Modell und Aufwand sind schon für dich gewählt (ein freier Rail und die Engine deines Gesprächs). Um sie zu ändern, öffne **Vorgehen ändern**; dort siehst du auch, was sich geändert hat. Die Kosten bisher stehen in der Hauptzeile. Deine Auswahl bleibt erhalten, wenn du **Noch nicht** drückst und später erneut übergibst. Während die Übergabe startet, zeigt die Leiste den Start ohne Lücke und folgt dann dem Lauf Schritt für Schritt. Ist das Review-Limit oder ein Budget erreicht, sagt die Zeile das, und nichts startet. Zeigt sich der Lauf nach 45 Sekunden noch nicht, hört die Leiste auf zu drehen und zeigt **Wird noch an Rail 2 übergeben…** mit **Aktualisieren**, das erneut nachsieht und weiter wartet, bis der Lauf erscheint.

Der Rail leitet aus dem Gebauten die Spec und ihre Spec-Änderung ab, prüft und reviewt sie, und die Auslieferungskarte erscheint in der Mission wie bei jedem Lauf.

Scheitert der Lauf aus technischem Grund, kommt die Arbeit von selbst unversehrt in diesen Intent zurück: Die Karte sagt in einfachen Worten, was fehlschlug (die Codes bleiben unter **Technische Details**), und der Agent erhält den Fehler und erklärt ihn. Verlangt die Review Änderungen, bietet die Karte **Zurück zum Intent** oder **Neu starten**. Sobald die Arbeit integriert ist, schließt die Mission den Intent mit einer Erfolgskarte, die den Namen deiner Spec trägt: wie viel sich geändert hat (Dateien, Kosten, Zeit, Branch), wie es ins Projekt kam (der Pull Request oder *Lokal in main integriert*), die aus dem Gebauten neu geschriebene Spec, die archivierte Spec-Änderung, der Jira-Vorgang, falls vorhanden, und die offenen Fragen, die die Arbeit beantwortet hat. Sie erscheint sofort und füllt sich, während die Spec neu geschrieben wird. Darunter führen **Spec öffnen**, **Pull Request ansehen** weiter.

## Gut zu wissen

- Intent schreibt nur auf seinem eigenen Branch. Außerhalb von Intent bleiben Missionen schreibgeschützt.
- Ein Intent pro Mission zur gleichen Zeit. Eine Pause übersteht einen Neustart der App.
- Verschwindet die Projektkopie des Flows, wird der Intent als **muss geprüft werden** markiert (zur Info, nichts zu entscheiden), und nichts wird gelöscht.
- Die Leiste wechselt nie den Lauf, den du gerade ansiehst. Braucht dich inzwischen ein anderer Lauf, sagt sein Name im Umschalter der Leiste **braucht dich**.
- Jira erhält nichts, solange du im Intent bist oder wenn du ihn verwirfst.
- Intent-Kosten erscheinen in der Analyse als eigene Oberfläche, **Intent**, und im Block der Agenten-Missionen.
