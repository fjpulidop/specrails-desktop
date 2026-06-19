# Die Job-Detail-Ansicht

Klick auf eine beliebige Job-Karte auf der **Jobs**-Seite, und du landest hier: dem Cockpit für einen einzelnen Rail-Lauf. Alles dreht sich um ein Versprechen — **die Live-Zahlen, die du siehst, sind echt, niemals geraten.** Diese Seite führt dich durch die Phasen, die Live-Metriken und die Ticket-Karten.

## Das Layout

Über dem vollständigen Streaming-Log sitzen zwei Panels:

```
┌─────────────────────────────────────────────┐
│  Status-Header  (Icon · Live-Dauer · …)     │
├─────────────────────────────────────────────┤
│  Ticket-Header  ( #12  #14  #15 )           │
├─────────────────────────────────────────────┤
│                                             │
│  Streaming-Log  (Auto-Scroll · Suche · …)   │
│                                             │
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

Welcher Agent welche Phase übernimmt, entscheidet das **Agent-Profil** des Projekts. Das Basistrio (`sr-architect`, `sr-developer`, `sr-reviewer`) ist immer vorhanden; Routing-Regeln in einem Profil können weitere Agents hinzufügen oder austauschen, wer eine Phase ausführt. Die Phasen-Fortschrittsleiste erscheint nur, wenn der Befehl tatsächlich Phasen definiert — Ultracode-Jobs (die die Pipeline umgehen) zeigen keine an.

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
