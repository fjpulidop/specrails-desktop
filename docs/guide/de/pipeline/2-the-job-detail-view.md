# Die Job-Detail-Ansicht

Klick auf eine beliebige Job-Karte auf der **Jobs**-Seite, und du landest hier: dem Cockpit für einen einzelnen Rail-Lauf. Alles dreht sich um ein Versprechen — **die Live-Zahlen, die du siehst, sind echt, niemals geraten.** Diese Seite führt dich durch die Phasen, die Live-Metriken, die Spec-Karten — und den Composer, mit dem du **mit dem laufenden Job sprechen** kannst.

## Das Layout

Der kompakte Header enthält Status, Laufzeit, Phase, Aktionen und Pipeline-Chips. Direkt darunter bündelt **eine Navigationszeile** alles, was du dir ansehen kannst:

- **Fehlerursachen** – vorhanden bei einem fehlgeschlagenen oder abgebrochenen Lauf mit Diagnose und dann zuerst ausgewählt. Eine beantwortbare offene Frage macht den Tab ebenfalls verfügbar: Ein Klick auf die Frage-Schaltfläche im Header führt dorthin, auch ohne Diagnose.
- **Ausführungsgraph** und **Protokolldetails** – bei Loop-Läufen der Graph des Workflows und das Protokoll Schritt für Schritt.
- **Protokoll** – bei einfachen Jobs das Streaming-Log.

Neben den Tabs stehen nur die Chips, die der Lauf tatsächlich hat: **Verifizierung** (mit der Anzahl der Prüfungen, in der Farbe seines Zustands), wenn der Lauf Verifizierungsnachweise aufgezeichnet hat – ein Klick zeigt die Prüfungen und ihre Ausgabe –, und eine Schaltfläche **Details** (Balkendiagramm-Symbol), wenn es echte Messwerte gibt. Beide öffnen sich als Popover, sodass das Log immer die volle Höhe behält. Der zuletzt gewählte Log-Bereich wird für die Seite und das Missionsfenster getrennt gespeichert; der ausgewählte Tab wird bei jedem Besuch zurückgesetzt.

### Ausführungsanweisungen

Solange ein Lauf sie noch lesen kann, ist unten am Log ein einzeiliger Composer angedockt: Schreibe, was der Agent berücksichtigen soll, und drücke die Senden-Schaltfläche oder **⌘↵** (**Strg+Enter**). **Enter** fügt eine Zeile hinzu. Das **ⓘ** erklärt die Regel: Anweisungen werden beim nächsten passenden Zug des Agenten angewendet; sie beantworten keine Frage und erteilen keine Freigabe. Was du gesendet hast, erscheint als Chip neben dem Composer – *1 wartend*, *2 angewendet* –, der jede Nachricht mit ihrem Status auflistet. Sobald der Lauf abgeschlossen ist, verschwindet der Composer; ein vergangener Lauf mit Anweisungen behält den Chip schreibgeschützt neben den Tabs.

In der Desktop-App erscheint ein aus einer Mission geöffneter Job in **einem eigenen Fenster**, ein Fenster pro Job. Drücke **Escape** oder schließe das Fenster, um zurückzukehren; die Browser-Version zeigt denselben Inhalt in einem Modal.

## Pipeline-Phasen

Bei `Implement`-Jobs durchläuft der Lauf die Phasen, die der Slash-Befehl definiert — standardmäßig:

```
Architect ──► Developer ──► Reviewer ──► Ship
```

Jede Phase ist ein spezialisierter Agent, den die Engine der Rail in deinem Projektverzeichnis aufruft:

| Phase | Agent | Was er macht |
|-------|-------|--------------|
| **Architect** | `sr-architect` | Plant die Implementierung. |
| **Developer** | `sr-developer` | Schreibt den Code. |
| **Reviewer** | `sr-reviewer` | Prüft das Ergebnis. |
| **Ship** | (variiert) | Letzter Feinschliff: Tests, Commit, PR-Entwurf. |

Welcher Agent welche Phase übernimmt, entscheidet das **Agent-Profil** des Projekts. Das Basistrio (`sr-architect`, `sr-developer`, `sr-reviewer`) ist immer vorhanden; Routing-Regeln in einem Profil können weitere Agents hinzufügen oder austauschen, wer eine Phase ausführt. Die Phasen-Fortschrittsleiste erscheint nur, wenn der Befehl tatsächlich Phasen definiert — Jobs, die die Pipeline umgehen (etwa ein Freestyle-Loop aus der Galerie), zeigen keine an.

## Live-Metriken — ehrlich von Grund auf

Der kompakte Header zeigt Status, Laufzeit, Aktivität, Schritte und Aktionen. Echte Messwerte und Hinweise zur Fortsetzung öffnen sich über die Schaltfläche **Details** neben den Tabs:

| Metrik | Wann du den echten Wert siehst |
|--------|------------------------------|
| **Dauer** | **Live.** Ein 1-Sekunden-Ticker zählt hoch, während der Job läuft — das ist die einzige wirklich live aktualisierte Zahl. |
| **Turns** | Inkrementell aus den gestreamten Assistant-Events abgeleitet, sobald sie eintreffen. |
| **Tokens** | Inkrementell aus demselben Stream zusammengezählt (tolerant gegenüber Events, denen Usage-Felder fehlen). |
| **Kosten** | Werden als `—` angezeigt, bis der Job endet, dann als verbindlicher `total_cost_usd` enthüllt. |

Das Designprinzip: **keine ungefähren oder geschätzten Zahlen während des Laufs.** Die Dauer ist echt, weil sie nichts anderes als eine Uhr ist. Turns und Tokens werden aus tatsächlich gestreamter Aktivität aufaddiert. Die Kosten werden während des Laufs bewusst *nicht* geschätzt — sie erscheinen als ausstehend und lösen sich erst zu ihrer finalen, verbindlichen Zahl auf, wenn der Provider sie beim Job-Ende meldet. Wenn eine Zahl so aussieht, als würde sie warten, ist das Absicht — dir wird die Wahrheit gezeigt, keine Hochrechnung.

Das Label und das Icon im Header entsprechen dem Status des Jobs, und das Panel wird für `running`-, `completed`- und `failed`-Jobs gleichermaßen gerendert — die Detail-Ansicht eines abgeschlossenen Jobs zeigt also dieselben Metriken, eingefroren auf ihren Endwerten.

## Die Spec-Karten

Der **Spec-Header** sitzt zwischen dem Status-Header und dem Log. Es ist eine hochwertige Identitäts-Karte, die einen Chip für jede Spec zeigt, die der Job berührt hat — aus dem gestarteten Befehl abgeglichen, sodass er exakt widerspiegelt, um welche Specs es bei diesem Lauf ging.

- **2–3 Specs** — als Liste von Chips angezeigt.
- **4 oder mehr** — werden zu einem kompakten `+ N more`-Modus mit einem Aufklapp-Chevron zusammengefasst, damit der Header aufgeräumt bleibt.

Ein Klick auf einen Chip öffnet die Detailansicht dieser Spec **über der Job-Seite** — du verlierst deinen Platz nicht und wechselst die Route nicht. Eine schnelle Möglichkeit, noch einmal nachzulesen, was ein Job liefern soll, während du ihm bei der Arbeit zusiehst. (Auf tabletbreiten Bildschirmen kannst du ein Spec-Modal sogar zur Seite ziehen, um zwei Specs nebeneinander zu vergleichen.)

## Das Streaming-Log

Öffne **Protokoll** (einfache Jobs) oder **Protokolldetails** (Loop-Läufe) für das Streaming-Log oder wähle Story bei aktivierter Erzählansicht. Die Rohausgabe kommt in Echtzeit über WebSocket:

- **Auto-Scroll** hält die neueste Ausgabe im Blick (scrollst du hoch, pausiert es, damit du in Ruhe lesen kannst).
- **Suche**, um zu einer Stelle zu springen.
- **Copy**, um das ganze Log zu greifen.

Das ist die rohe Wahrheit darüber, was die KI tut — jeder Tool-Aufruf, jede Dateibearbeitung, jeder Testlauf.

## Loop-Läufe: der Graph und das Schritt-Protokoll

Bei einem **Loop-Lauf** (siehe [Der Loop Builder](the-loop-builder)) zeigen zwei Tabs die Belege.

**Ausführungsgraph** ist der Workflow, so wie er gelaufen ist. Er ist immer ausgeklappt und folgt dem laufenden Schritt oder dem, der fehlgeschlagen ist:

- **Der gegangene Pfad ist durchgezogen.** Schritte, die der Lauf durchlaufen hat, sind durchgezogen gezeichnet; nie erreichte Schritte sind gestrichelt und abgeschwächt. Schalte **Nur der gegangene Pfad** ein, um den Rest auszublenden. Eine Legende steht direkt daneben.
- **Einen Schritt untersuchen.** Wähle einen Knoten, um seine Versuche mit Zustand und Dauer aufzulisten. Klicke auf einen Versuch, um sein Protokoll in Protokolldetails zu öffnen. **Ab hier wiederholen** steht in der Zeile jedes abgeschlossenen Versuchs, sodass ein verknüpfter Lauf genau bei dem Versuch beginnt, den du gewählt hast. Technische IDs stehen unter **Trace**.

**Protokolldetails** enthält die Schrittspur und das Protokoll und öffnet sich beim fehlgeschlagenen Schritt:

- **Die Schrittleiste** oben listet nur die Schritte, die der Lauf erreicht hat, in Reihenfolge, mit einem Iterationszähler (`Iteration 3/10`) rechts. Die Chips sind im Wartezustand abgedunkelt, pulsieren während der Ausführung und zeigen danach einen Haken oder ein Kreuz; der Chip eines Entscheiders zeigt zudem das Urteil, nach dem er geroutet hat. Klicke auf einen Chip, um zu diesem Schritt zu springen.
- **Eine aufklappbare Box pro Schritt.** Jeder Durchlauf über einen Knoten wird zu einer eigenen Sektion mit Schrittnummer, Name, Iterations-Badge, der Dauer nach Abschluss — und einem eigenen Kopieren-Button, mit dem du dir exakt die Ausgabe eines Schritts holst. (Das Kopieren in der Werkzeugleiste nimmt weiterhin das ganze Log.) Alles, was vor dem ersten Schritt ausgegeben wird — das Start-Banner, der Worktree-Hinweis — landet in einer **Vorbereitung**-Sektion.
- **Der Folgemodus** ist standardmäßig an: Der laufende Schritt bleibt offen und scrollt automatisch mit, während sich frühere Schritte zusammenfalten. Sobald du hochscrollst oder einen älteren Schritt öffnest, pausiert das Folgen, damit du lesen kannst — eine schwebende Pille **Verfolgung fortsetzen** bringt dich zurück ins Live-Geschehen. **Alle ausklappen / Alle einklappen** sitzen in der Werkzeugleiste, und die Suche durchsucht alle Schritte auf einmal.
- **Auch unterbrochene Schritte sind ehrlich.** Ein Schritt, der sein Ergebnis nie melden konnte — der Lauf wurde abgebrochen oder die App ging mitten im Schritt aus — wird mit gestrichelter Umrandung als **Unterbrochen** markiert, statt so zu tun, als wäre er fertig geworden.

Story wird bei aktivierter Erzählansicht innerhalb von Protokolldetails angeboten. Graph-Erkundung und eine pausierte Protokollposition bleiben beim Tabwechsel erhalten.

## Sprich mit dem laufenden Job

Jeder Claude-Job läuft standardmäßig als **Live-Session**, deshalb sitzt am Fuß dieser Seite — und des Job-Modals im Missionsmodus — ein Chat-Composer. Nutze ihn, um dem laufenden Agenten eine Frage zu stellen („warum ist dieser Test fehlgeschlagen?") oder ihn mitten im Lauf zu lenken („überspring das Refactoring, konzentrier dich auf den Fix").

Ein paar Dinge, die man wissen sollte:

- **Nachrichten reihen sich ein, sie unterbrechen nicht.** Sende, während der Agent streamt, und deine Nachricht wartet, bis sie dran ist — sie läuft als nächster Prompt, und der Job folgt weiter seinem Plan. Ein kleiner Zähler zeigt, wie viele Nachrichten in der Warteschlange stehen.
- **Die Summenzeile ist echt.** Der Composer zeigt eine Live-Zusammenfassung `N Turns · $X`, aufsummiert aus dem tatsächlichen Verbrauch jedes abgeschlossenen Turns — konsistent mit dem Versprechen dieser Seite, nichts zu raten.
- **Zwei Arten, wie eine Session endet.** Die meisten Jobs **schließen sich selbst ab**: Sobald ein Turn ohne wartende Nachrichten endet, setzt sich die Session zur Ruhe und der Job ist fertig — deine Nachrichten sind optionale Lenkung, nie eine Pflicht. Eine dezente Aktion **Jetzt abschließen** beendet sie früher, mit allem, was bis dahin entstanden ist. Ältere **Freestyle**-Jobs (aus der Zeit, bevor Freestyle ein Galerie-Loop wurde) sind die Ausnahme: Sie warten zwischen den Turns, bis du auf **Finalize** klickst — das ist ihr Design, eine Hin-und-her-Session, die du schließt, wenn du fertig bist.
- **Bei Loop-Läufen geht die Nachricht an den aktiven Schritt.** In einem eingebauten oder eigenen Loop erreicht deine Nachricht den **gerade laufenden KI-Schritt**. Zwischen den Schritten (während der Loop Decider nachdenkt oder ein Shell-Befehl läuft) zeigt der Composer kurz *„Warte auf den nächsten Schritt…"* — dein Entwurf bleibt erhalten, und das Senden wird wieder aktiv, sobald der nächste KI-Schritt startet. **Diesen Schritt abschließen** beendet den aktuellen Schritt vorzeitig und lässt den Loop mit dem Erreichten weiterziehen.

## Diagnose-Export

Wenn [Telemetrie](../settings/pipeline-telemetry-and-diagnostics) für den Job aktiviert war, erscheint im Header ein Button **Export diagnostic**. Er lädt ein ZIP herunter, das Folgendes enthält:

- `job-metadata.json` — Befehl, Status, Profil, Plugins.
- `telemetry.ndjson` — unkomprimierte OTLP/JSON-Signale.
- `logs.txt` — das vollständige Streaming-Log.
- `summary.md` — menschenlesbare Highlights.
- `profile.json`, `plugins.json` — exakte Snapshots dessen, was lief (sofern vorhanden).

Praktisch, um einen Lauf mit einem Teammitglied zu teilen oder einen präzisen Fehlerbericht einzureichen.

## Wenn ein Lauf fehlschlägt

Bei einem fehlgeschlagenen oder abgebrochenen Job mit Diagnose öffnet sich **Fehlerursachen** mit der **Diagnosekarte**, die die Ursache erklärt und, wenn bekannt, warum es dazu kam. Hat die Laufzeit festgehalten, welcher Schritt fehlgeschlagen ist, nennt die Karte ihn: Schritt, Versuch, Iteration und Zeitpunkt. Die Ursachen:

- **Tests fehlgeschlagen**: Die Prüfungen schlagen nach den Korrekturrunden weiter fehl.
- **Anbieterlimit** — das Nutzungslimit des KI-Anbieters wurde erreicht. Die Karte nennt den Reset in deiner Ortszeit, wenn der Anbieter den genauen Zeitpunkt gemeldet hat, sonst in den Worten des Anbieters. Ein Lauf, der noch am Limit pausiert, zeigt stattdessen seine eigene Karte: wann er von selbst fortsetzt, **Jetzt fortsetzen** und **Jetzt mit** einem anderen Anbieter **fortsetzen**. Siehe [Nutzungslimits](1-rails-and-jobs.md#usage-limits).
- **Umgebung**: Der Rechner kann die Prüfungen nicht ausführen (Zugangsdaten, fehlendes Werkzeug, fehlschlagender Setup-Befehl). *Umgebung reparieren* zeigt genau, was auszuführen oder zu ändern ist.
- **Port belegt**: Die Prüfung oder der Server des Laufs konnte nicht starten, weil ein anderer Prozess seinen Port schon belegte (`EADDRINUSE`). Das zählt nicht als fehlgeschlagene Tests. Jedes Lauf-Worktree bekommt eigene Ports über `PORT` und `SPECRAILS_RUN_PORT_RANGE_START`/`_END`; ein Projekt, das `PORT` liest, kollidiert nie. Beende den anderen Prozess oder lass das Projekt `PORT` lesen, dann **Erneut ausführen**.
- **Blockiert**, **Zeit überschritten**, **stumm geblieben** und **unerwartet gestoppt** nennen das Limit oder den Prozess, der den Lauf angehalten hat.
- **Unerledigte Aufgaben**: Der Lauf hat die Arbeit gemacht, aber freigegebene Aufgaben nicht abgehakt, etwa eine visuelle Prüfung. Die Karte listet sie auf. **Weiter zum Review** behält die Arbeit und schickt sie mit dem Rest als *Prüfung von Hand* im Review-Paket ins Review; **Mit dem Browser erneut versuchen** startet den Entwickler neu, der die Oberfläche mit dem eingebauten Browser-Werkzeug selbst prüft und fehlende Werkzeuge installiert.
- **Spezifikation abgelehnt**: OpenSpec hat den Plan oder die Spezifikation abgelehnt, und die Planung konnte es nicht reparieren. **Spec bearbeiten und neu starten**.
- **Unbekannte Ursache**: Die Aufzeichnungen des Laufs nennen keine Ursache, und die App rät nicht. Die Karte zeigt stattdessen zuerst die KI-Analyse, als solche gekennzeichnet, oder bietet **Mit KI analysieren** als erste Aktion an; das Ende des Logs bleibt einen Klick entfernt.

Unter der Diagnose stehen bis zu drei gereihte Abhilfen, und nur solche, die hier funktionieren können: **Fortsetzen ab** der angehaltenen Phase, **Erneut ausführen**, **Spec bearbeiten und neu starten** (die Nachträge der Spec tragen deine Änderung in den nächsten Lauf), **Umgebung reparieren** und **Protokoll am Fehler öffnen**. Dieselbe Ursache erscheint als einzeilige Bezeichnung in der [Liste „Offen“](../getting-started/the-dashboard-tour), und die Lauf-Karte der Mission zeigt dieselbe Karte.

Implement-Läufe prüfen Oberfläche und visuelles Verhalten selbst: Jeder Lauf erhält ein Headless-Browser-Werkzeug (`$SPECRAILS_BROWSE`), das die App auf dem eigenen Port des Laufs oder eine Seite des Repositorys in Desktop- und Handygröße öffnet und Screenshots liefert, die der Agent liest. Eine Prüfung, die nur ein Mensch machen kann (Geschmack, ein echtes Gerät, echte Zugangsdaten), wird als *Prüfung von Hand* geplant: Der Lauf scheitert nie daran, und sie erreicht dich im Review-Paket.

### KI-Analyse {#ai-failure-analysis}

Unter der Karte liest eine **KI-Analyse** das Protokoll und erklärt, warum der Lauf gestoppt hat: die Ursache, **Nächste Schritte** und die Zeilen **Aus dem Protokoll**, auf die sie sich stützt, wörtlich zitiert. Sie läuft mit demselben Anbieter und Modell, die den Job ausgeführt haben, sodass dein Konto sie immer ausführen kann. Sie startet von selbst, außer wenn das Limit des Anbieters die Ursache war; dann drücke **Mit KI analysieren**. Die Analyse wird mit dem Job gespeichert. Ändert sich das Protokoll danach, sagt sie das und bietet **Erneut analysieren** an.

Die Analyse ist als KI-Lesart gekennzeichnet und ersetzt nie die Karte: Diagnose, Ursache und Abhilfen bleiben das, was die App erfasst hat. Prüfe die zitierten Zeilen, bevor du danach handelst. Ihre Kosten zählen unter **Support** in [Analytics](../insights/analytics-and-cost-tracking).

## Wie es weitergeht

- [Rails & Jobs](rails-and-jobs) — Starten und Einreihen in die Queue.
- [Analytics & Kostenverfolgung](../insights/analytics-and-cost-tracking) — aus Kosten pro Job Projekt-Analysen machen.

## Nach einem Workflow-Neustart

Setze nach einem Absturz den gespeicherten Workflow mit seiner ursprünglichen Konfiguration und seinen ursprünglichen Repositorys fort. Prüfe bei einem unterbrochenen Schreibvorgang zuerst den Worktree-Diff und wähle dann den genauen Versuch aus. Abgeschlossene Schritte bleiben erhalten. Ein Anbieteraufruf mit verlorener Antwort wird weiterhin als unterbrochen mit unbekanntem Verbrauch gezählt, niemals als kostenlos. Lässt sich die ursprüngliche Auslieferung anhand der gespeicherten Daten nicht belegen, zeigt die Wiederherstellung einen Fehler und erhält den Worktree.

Wenn ein Entscheidungsschritt wegen einer Frage pausiert, verwendet die Fortsetzung die gespeicherte Entscheidung und gibt die menschliche Antwort an den nächsten Schritt weiter. Das Modell wird für dieselbe Entscheidung nicht erneut aufgerufen. Ein pausierter Prompt kann einen weiteren Modellaufruf benötigen, um deine Antwort umzusetzen.

## Aufbewahrung des Verlaufs

Gespeicherte Ausführungen werden standardmäßig unbegrenzt aufbewahrt. Unter **Gespeicherte Ausführungen → Aufbewahrung des Verlaufs** kann ein Projekt sie stattdessen 1 bis 3650 Tage aufbewahren. Im Hintergrund wird nichts gelöscht: Speichere die Richtlinie, wähle **Bereinigung prüfen** und prüfe jede Ausführung samt Grund, bevor du **Abgelaufenen Verlauf löschen** wählst. Eine Ausführung bleibt geschützt, solange sie aktiv ist, auf deine Antwort oder Freigabe wartet, einen unterbrochenen Schreibvorgang, eine offene Auslieferung oder einen davon abhängigen Fork hat. Entfernt wird nur der Laufzeitverlauf im Specrails-Speicher des Projekts; Repository, Worktrees, Job-Log und Kostendaten bleiben erhalten. Eine abgelaufene Ausführung wird als **Abgelaufen** angezeigt und kann nicht mehr fortgesetzt oder geforkt werden. Core-Versionen, die eine verbleibende Ausführung noch nutzt, bleiben immer erhalten.
