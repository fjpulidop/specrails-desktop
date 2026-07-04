# Die Job-Detail-Ansicht

Klick auf eine beliebige Job-Karte auf der **Jobs**-Seite, und du landest hier: dem Cockpit für einen einzelnen Rail-Lauf. Alles dreht sich um ein Versprechen — **die Live-Zahlen, die du siehst, sind echt, niemals geraten.** Diese Seite führt dich durch die Phasen, die Live-Metriken, die Ticket-Karten — und den Composer, mit dem du **mit dem laufenden Job sprechen** kannst.

## Das Layout

Über dem vollständigen Streaming-Log sitzen zwei Panels; bei einem laufenden Claude-Job sitzt darunter ein Chat-Composer:

```
┌─────────────────────────────────────────────┐
│  Status-Header  (Icon · Live-Dauer · …)     │
├─────────────────────────────────────────────┤
│  Ticket-Header  ( #12  #14  #15 )           │
├─────────────────────────────────────────────┤
│                                             │
│  Streaming-Log  (Auto-Scroll · Suche · …)   │
│                                             │
├─────────────────────────────────────────────┤
│  Composer  (Nachricht an den Job senden · …)│
└─────────────────────────────────────────────┘
```

## Pipeline-Phasen

Bei `Implement`- und `Batch`-Jobs durchläuft der Lauf die Phasen, die der Slash-Befehl definiert — standardmäßig:

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

Welcher Agent welche Phase übernimmt, entscheidet das **Agent-Profil** des Projekts. Das Basistrio (`sr-architect`, `sr-developer`, `sr-reviewer`) ist immer vorhanden; Routing-Regeln in einem Profil können weitere Agents hinzufügen oder austauschen, wer eine Phase ausführt. Die Phasen-Fortschrittsleiste erscheint nur, wenn der Befehl tatsächlich Phasen definiert — Freestyle-Jobs (die die Pipeline umgehen) zeigen keine an.

## Live-Metriken — ehrlich von Grund auf

Der Status-Header ist die Schlagzeile. Er zeigt ein Status-Icon, eine Aktivitätszeile, die beschreibt, was der Job *gerade jetzt* tut, eine Zählung der ausgeführten Schritte und eine Reihe von Metriken:

| Metrik | Wann du den echten Wert siehst |
|--------|------------------------------|
| **Dauer** | **Live.** Ein 1-Sekunden-Ticker zählt hoch, während der Job läuft — das ist die einzige wirklich live aktualisierte Zahl. |
| **Turns** | Inkrementell aus den gestreamten Assistant-Events abgeleitet, sobald sie eintreffen. |
| **Tokens** | Inkrementell aus demselben Stream zusammengezählt (tolerant gegenüber Events, denen Usage-Felder fehlen). |
| **Kosten** | Werden als `—` angezeigt, bis der Job endet, dann als verbindlicher `total_cost_usd` enthüllt. |

Das Designprinzip: **keine ungefähren oder geschätzten Zahlen während des Laufs.** Die Dauer ist echt, weil sie nichts anderes als eine Uhr ist. Turns und Tokens werden aus tatsächlich gestreamter Aktivität aufaddiert. Die Kosten werden während des Laufs bewusst *nicht* geschätzt — sie erscheinen als ausstehend und lösen sich erst zu ihrer finalen, verbindlichen Zahl auf, wenn der Provider sie beim Job-Ende meldet. Wenn eine Zahl so aussieht, als würde sie warten, ist das Absicht — dir wird die Wahrheit gezeigt, keine Hochrechnung.

Das Label und das Icon im Header entsprechen dem Status des Jobs, und das Panel wird für `running`-, `completed`- und `failed`-Jobs gleichermaßen gerendert — die Detail-Ansicht eines abgeschlossenen Jobs zeigt also dieselben Metriken, eingefroren auf ihren Endwerten.

## Die Ticket-Karten

Der **Ticket-Header** sitzt zwischen dem Status-Header und dem Log. Es ist eine hochwertige Identitäts-Karte, die einen Chip für jede Spec zeigt, die der Job berührt hat — aus dem gestarteten Befehl abgeglichen, sodass er exakt widerspiegelt, um welche Tickets es bei diesem Lauf ging.

- **2–3 Tickets** — als Liste von Chips angezeigt.
- **4 oder mehr** — werden zu einem kompakten `+ N more`-Modus mit einem Aufklapp-Chevron zusammengefasst, damit der Header aufgeräumt bleibt.

Ein Klick auf einen Chip öffnet die Detailansicht dieser Spec **über der Job-Seite** — du verlierst deinen Platz nicht und wechselst die Route nicht. Eine schnelle Möglichkeit, noch einmal nachzulesen, was ein Job liefern soll, während du ihm bei der Arbeit zusiehst. (Auf tabletbreiten Bildschirmen kannst du ein Ticket-Modal sogar zur Seite ziehen, um zwei Specs nebeneinander zu vergleichen.)

## Das Streaming-Log

Unter den Panels liegt das vollständige Log des Laufs, in Echtzeit über den WebSocket gestreamt:

- **Auto-Scroll** hält die neueste Ausgabe im Blick (scrollst du hoch, pausiert es, damit du in Ruhe lesen kannst).
- **Suche**, um zu einer Stelle zu springen.
- **Copy**, um das ganze Log zu greifen.

Das ist die rohe Wahrheit darüber, was die KI tut — jeder Tool-Aufruf, jede Dateibearbeitung, jeder Testlauf.

## Loop-Läufe: der Schritt-Explorer

Wenn der Job ein **Loop-Lauf** ist (siehe [Der Loop Builder](the-loop-builder)), macht das flache Log einem **Schritt-Explorer** Platz, der die tatsächliche Form des Loops abbildet:

- **Die Übersichtsleiste** oben ist die Live-Karte des Loops — ein Chip pro Knoten (KI-Schritt, Shell, Loop-Entscheider…), in der Reihenfolge, in der der Graph fließt. Die Chips leuchten auf, während der Lauf voranschreitet: abgedunkelt im Wartezustand, pulsierend während der Ausführung, danach ein Haken oder ein Kreuz. Der Chip eines Entscheiders zeigt zudem das Urteil, nach dem er geroutet hat — zurück in die Schleife oder weiter — und ein Iterationszähler (`Iteration 3/10`) führt rechts Buch. Klick auf einen beliebigen Chip, um direkt zum letzten Schritt dieses Knotens zu springen.
- **Eine aufklappbare Box pro Schritt.** Jeder Durchlauf über einen Knoten wird zu einer eigenen Sektion mit Schrittnummer, Name, Iterations-Badge, der Dauer nach Abschluss — und einem eigenen Kopieren-Button, mit dem du dir exakt die Ausgabe eines Schritts holst. (Das Kopieren in der Werkzeugleiste nimmt weiterhin das ganze Log.) Alles, was vor dem ersten Schritt ausgegeben wird — das Start-Banner, der Worktree-Hinweis — landet in einer **Vorbereitung**-Sektion.
- **Der Folgemodus** ist standardmäßig an: Der laufende Schritt bleibt offen und scrollt automatisch mit, während sich frühere Schritte zusammenfalten. Sobald du hochscrollst oder einen älteren Schritt öffnest, pausiert das Folgen, damit du lesen kannst — eine schwebende Pille **Verfolgung fortsetzen** bringt dich zurück ins Live-Geschehen. **Alle ausklappen / Alle einklappen** sitzen in der Werkzeugleiste, und die Suche durchsucht alle Schritte auf einmal.
- **Auch unterbrochene Schritte sind ehrlich.** Ein Schritt, der sein Ergebnis nie melden konnte — der Lauf wurde abgebrochen oder die App ging mitten im Schritt aus — wird mit gestrichelter Umrandung als **Unterbrochen** markiert, statt so zu tun, als wäre er fertig geworden.

Alles andere auf dieser Seite funktioniert bei Loop-Läufen exakt gleich — die Live-Metriken, die Ticket-Karten, der Composer. Jobs ohne Loop behalten das klassische Streaming-Log oben.

## Sprich mit dem laufenden Job

Jeder Claude-Job läuft standardmäßig als **Live-Session**, deshalb sitzt am Fuß dieser Seite — und des Job-Modals im Missionsmodus — ein Chat-Composer. Nutze ihn, um dem laufenden Agenten eine Frage zu stellen („warum ist dieser Test fehlgeschlagen?") oder ihn mitten im Lauf zu lenken („überspring das Refactoring, konzentrier dich auf den Fix").

Ein paar Dinge, die man wissen sollte:

- **Nachrichten reihen sich ein, sie unterbrechen nicht.** Sende, während der Agent streamt, und deine Nachricht wartet, bis sie dran ist — sie läuft als nächster Prompt, und der Job folgt weiter seinem Plan. Ein kleiner Zähler zeigt, wie viele Nachrichten in der Warteschlange stehen.
- **Die Summenzeile ist echt.** Der Composer zeigt eine Live-Zusammenfassung `N Turns · $X`, aufsummiert aus dem tatsächlichen Verbrauch jedes abgeschlossenen Turns — konsistent mit dem Versprechen dieser Seite, nichts zu raten.
- **Zwei Arten, wie eine Session endet.** Die meisten Jobs **schließen sich selbst ab**: Sobald ein Turn ohne wartende Nachrichten endet, setzt sich die Session zur Ruhe und der Job ist fertig — deine Nachrichten sind optionale Lenkung, nie eine Pflicht. Eine dezente Aktion **Jetzt abschließen** beendet sie früher, mit allem, was bis dahin entstanden ist. **Freestyle**-Jobs sind die Ausnahme: Sie warten zwischen den Turns, bis du auf **Finalize** klickst — das ist ihr Design, eine Hin-und-her-Session, die du schließt, wenn du fertig bist.
- **Bei Loop-Läufen geht die Nachricht an den aktiven Schritt.** In einem eingebauten oder eigenen Loop erreicht deine Nachricht den **gerade laufenden KI-Schritt**. Zwischen den Schritten (während der Loop Decider nachdenkt oder ein Shell-Befehl läuft) zeigt der Composer kurz *„Warte auf den nächsten Schritt…"* — dein Entwurf bleibt erhalten, und das Senden wird wieder aktiv, sobald der nächste KI-Schritt startet. **Diesen Schritt abschließen** beendet den aktuellen Schritt vorzeitig und lässt den Loop mit dem Erreichten weiterziehen.
- **Vorerst nur Claude.** Codex- und Gemini-Jobs laufen wie bisher als One-Shot — es erscheint kein Composer. (Server-Betreiber können das ganze Feature mit `SPECRAILS_INTERACTIVE_JOBS=false` abschalten.)

## Diagnose-Export

Wenn [Telemetrie](../settings/customizing) für den Job aktiviert war, erscheint im Header ein Button **Export diagnostic**. Er lädt ein ZIP herunter, das Folgendes enthält:

- `job-metadata.json` — Befehl, Status, Profil, Plugins.
- `telemetry.ndjson` — unkomprimierte OTLP/JSON-Signale.
- `logs.txt` — das vollständige Streaming-Log.
- `summary.md` — menschenlesbare Highlights.
- `profile.json`, `plugins.json` — exakte Snapshots dessen, was lief (sofern vorhanden).

Praktisch, um einen Lauf mit einem Teammitglied zu teilen oder einen präzisen Fehlerbericht einzureichen.

## Wie es weitergeht

- [Rails & Jobs](rails-and-jobs) — Starten und Einreihen in die Queue.
- [Batch implement & Multi-Feature](batch-implement-and-multi-feature) — viele Specs, abhängigkeitsbewusste Wellen.
- [Kosten verfolgen](../analytics/tracking-cost) — aus Kosten pro Job Projekt-Analysen machen.
