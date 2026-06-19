# Rails & Jobs

Du hast Specs auf dem Board. Hier werden sie zu Code. Eine **Rail** ist die Spur, die eine Spec durch die komplette Pipeline schiebt — Architect → Developer → Reviewer → Ship — und dabei echte KI-Agents direkt in deinem Projektverzeichnis laufen lässt. Diese Seite zeigt dir, wie du eine Rail startest, wie die Job-Queue funktioniert und wie du der Arbeit live zusiehst.

## Was eine Rail ist

Stell dir deinen Bildschirm in zwei Hälften vor:

```
SpecsBoard (links)          Rails (rechts)
─────────────────            ─────────────────
#1 Login flow      ─┐
#2 Webhook retry    │  ziehen auf
#3 Cost limits      │ ────────────►   Rail 1   ▶ Play
#4 Audit log        │
                    └────────────►   Rail 2   ▶ Play
```

Eine Rail ist eine **Ausführungsspur**. Du ziehst eine Spec-Karte vom SpecsBoard auf eine Rail und drückst dann **▶ Play**. Die Rail startet die Pipeline und arbeitet die Spec von vorne bis hinten ab — direkt im Arbeitsverzeichnis deines Projekts: Dateien werden bearbeitet, Tests laufen, alles inklusive.

Du kannst mehrere Rails anlegen, um deine Arbeit in benannten Spuren zu organisieren (eine für das Feature, an dem du gerade dran bist, eine weitere, die dahinter wartet). Mehr zu mehreren Rails und zum Stapelbetrieb findest du unter [Batch implement & Multi-Feature](batch-implement-and-multi-feature).

## Eine Rail auf einer Spec starten

1. **Zieh eine Spec-Karte** vom SpecsBoard auf eine Rail. Die ID der Spec taucht in der Spec-Liste der Rail auf. (Du ziehst lieber nicht? Nutze das **Move to rail**-Popover auf der Spec-Karte — es zeigt pro Rail einen Status-Punkt, damit du keine Arbeit auf eine belegte Spur ablegst.)
2. **Wähle einen Modus**, falls du etwas anderes als den Standard möchtest — die segmentierte Auswahl im Rail-Header bietet `Implement`, `Batch` und (nur bei Claude-Rails) `Ultra`.
3. **Drück ▶ Play.**

Das war's. Die Rail startet einen KI-CLI-Prozess in deinem Projekt und legt mit der Pipeline los.

### Was im Rail-Header steckt

| Element | Was es macht |
|---------|--------------|
| **Status-Pill** | `idle`, `running` oder `failed`. Es gibt kein eigenes „completed“ — eine Rail kehrt auf `idle` zurück, wenn ihr Job sauber durchläuft. |
| **Spec-Liste** | Die IDs, die dieser Rail zugewiesen sind. Zieh weitere hinein oder heraus, um sie wieder zu lösen. |
| **Modus-Auswahl** | `Implement` / `Batch` / `Ultra` — siehe Tabelle unten. Pro Rail gespeichert. |
| **Profil-Auswahl** | Welches Agent-Profil läuft (nur bei Claude-Rails). Erscheint erst, wenn das Projekt mindestens ein Profil hat. |
| **Engine-Auswahl** | Welcher installierte Provider diese Rail ausführt — Claude, Codex oder Gemini. Wird nur angezeigt, wenn das Projekt mehr als einen Provider hat. Siehe [Engine pro Rail wählen](picking-an-engine-per-rail). |
| **▶ Play / ■ Stop** | Starten oder abbrechen. |

### Die drei Rail-Modi

| Modus | Befehl | Was er macht |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | Ein Job für alle Specs auf der Rail. Durchläuft die komplette Pipeline Architect → Developer → Reviewer → Ship. Der Alltagsstandard. |
| **Batch** | `/specrails:batch-implement` | Ein Job, der die Specs der Rail nacheinander abarbeitet — in abhängigkeitsbewussten Wellen. Ideal für mehrere zusammenhängende Specs. |
| **Ultra** | Ultracode | Claude implementiert jede Spec eigenständig und **umgeht** dabei die Pipeline. Ein unabhängiger Job pro Spec. Nur Claude. |

Ultra ist der Sonderfall: Es überspringt die Agent-Kette und übergibt Claude die rohe Spec, an der es mit seinen nativen Tools arbeitet. Das ist offen angelegt, deshalb öffnet Play zuerst eine Bestätigung, und eine Modell-Auswahl pro Rail lässt dich zwischen Haiku / Sonnet / Opus wählen. Ultra erscheint nur, wenn die Engine der Rail Claude ist.

## Die Job-Queue

Jedes Mal, wenn du Play drückst, wird der Rail-Lauf zu einem **Job**. Die wichtigste Regel, die du verinnerlichen solltest:

> **Ein Job pro Projekt — immer nur einer.** Jedes Projekt hat eine einzige Queue. Innerhalb eines Projekts läuft jeweils nur ein Rail-Job; der Rest stellt sich dahinter an und startet automatisch, sobald ein Platz frei wird.

Das überrascht Leute, die drei Rails anlegen und erwarten, dass sie parallel laufen. Tun sie nicht — jedenfalls nicht innerhalb desselben Projekts. Rails hinzuzufügen *organisiert* deine Arbeit in Spuren; es lässt diese Spuren nicht gleichzeitig laufen.

**Echte Parallelität gibt es zwischen Projekten.** Jedes Projekt hat seine eigene, unabhängige Queue — eine Rail in Projekt A und eine Rail in Projekt B laufen also gleichzeitig, ohne sich in die Quere zu kommen. Du willst mehr Durchsatz? Öffne mehr Projekte.

Es gibt keinen globalen Regler für die Parallelität. Die einzige automatische Bremse ist budgetbasiert: Wenn du ein Tagesbudget gesetzt hast (pro Projekt oder app-weit), pausiert die Queue von selbst, sobald die Ausgaben des Tages das Limit erreichen.

## Beim Laufen zusehen

Jeden Job findest du unter **Jobs** in der rechten Seitenleiste des Projekts — eine Kartenliste, die neuesten zuerst. Jede Karte zeigt ein Status-Badge, das Profil-Badge, ein Prioritäts-Badge, die Dauer, die Kosten und den gestarteten Befehl. Über der Liste:

- **Status-Filter-Chips** — zeigen nur Jobs in einem bestimmten Status.
- **Datumsbereich-Filter** — engt auf ein Zeitfenster ein.
- **Compare** — wähle zwei Jobs und betrachte sie nebeneinander.

Klick auf eine beliebige Karte, um die **Job-Detail-Ansicht** zu öffnen, in der das Live-Streaming-Log und die Live-Metriken stecken. Das ist die nächste Seite: [Die Job-Detail-Ansicht](the-job-detail-view).

## Einen Job abbrechen

Klick im Rail-Header auf **■ Stop**. Die App sendet `SIGTERM` an den Subprozess, wartet **5 Sekunden** auf einen sauberen Ausstieg und schickt dann `SIGKILL`. Es bleibt nichts halb gestartet zurück.

## Wenn eine Rail nicht starten will

Wenn du eine Engine wählst, deren CLI nicht auf deinem Rechner installiert ist, **schlägt der Start sofort fehl**, anstatt einen kaputten Job zu starten — es wird nichts gestartet. Installiere die fehlende Provider-CLI ([Codex verwenden](../integrations/using-codex), [Gemini verwenden](../integrations/using-gemini)) und starte erneut. Ein fehlendes Claude oder Codex liefert eine präzise „*&lt;provider&gt; CLI not found*“-Meldung; ein fehlendes Gemini zeigt heute eine generische Startfehlermeldung, aber das Ergebnis ist dasselbe.

## Alles stoppen

Wenn etwas nicht stimmt:

- **Eine einzelne Rail** — klick in ihrem Header auf **■ Stop**.
- **Auto-Pause beim Budget** — setze ein Tagesbudget, und die Queue pausiert sich selbst, sobald die Ausgaben des Tages das Limit erreichen.
- **Alles** — beende die Desktop-App oder führe `specrails-desktop stop` aus.

## Wie es weitergeht

- [Die Job-Detail-Ansicht](the-job-detail-view) — Phasen, Live-Metriken, Ticket-Karten.
- [Batch implement & Multi-Feature](batch-implement-and-multi-feature) — mehrere Specs auf einmal ausführen.
- [Engine pro Rail wählen](picking-an-engine-per-rail) — Claude vs. Codex vs. Gemini.
