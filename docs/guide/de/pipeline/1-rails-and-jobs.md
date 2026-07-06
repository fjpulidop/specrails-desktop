# Rails & Jobs

Du hast Specs auf dem Board. Hier werden sie zu Code. Eine **Rail** ist die Spur, die eine Spec durch die komplette Pipeline schiebt — Architect → Developer → Reviewer → Ship — und dabei echte KI-Agents für dein Projekt laufen lässt. Diese Seite zeigt dir, wie du eine Rail startest, wie parallele Ausführung funktioniert und wie du der Arbeit live zusiehst.

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

Eine Rail ist eine **Ausführungsspur**. Du ziehst eine Spec-Karte vom SpecsBoard auf eine Rail und drückst dann **▶ Play**. In Git-Repositories startet die Rail die Pipeline in einem isolierten Git-Worktree, damit die KI Dateien bearbeiten und Tests ausführen kann, ohne deinen aktiven Arbeitsbaum zu berühren. Ist das Projekt noch kein Git-Repo, degradiert Specrails klar sichtbar zur Ausführung im gemeinsamen Ordner und sagt dir, dass keine Branch- oder PR-Karte erscheinen wird.

Du kannst mehrere rails anlegen, um deine Arbeit in benannten Spuren zu organisieren (eine für das Feature, an dem du gerade dran bist, eine weitere, die dahinter wartet). Rails sind **dynamisch**: Der **+ Hinzufügen**-Button im Rails-Header erstellt eine neue Spur (bis zu 12 pro Projekt), und leere, inaktive Spuren lassen sich löschen. Jede rail ist server-gestützt — dein Spuren-Set übersteht Reloads und ist für den mobilen Companion und den eingebauten Agenten sichtbar; der Agent kann sogar selbst eine rail anlegen, wenn alle Spuren belegt sind. Mehr zu mehreren rails und zum Stapelbetrieb findest du unter [Batch implement & Multi-Feature](batch-implement-and-multi-feature).

## Eine Rail auf einer Spec starten

1. **Zieh eine Spec-Karte** vom SpecsBoard auf eine rail. Die ID der Spec taucht in der Spec-Liste der rail auf. (Du ziehst lieber nicht? Nutze das **Move to rail**-Popover auf der Spec-Karte — es zeigt pro rail einen Status-Punkt, damit du keine Arbeit auf eine belegte Spur ablegst.)
2. **Wähle einen Loop** im rail-Header. Eine rail führt einen **Loop** aus — das ist die Arbeit, die sie erledigt. Standard ist der eingebaute `Implement`-Loop; du kannst auch `Batch`, `Freestyle` oder einen selbst gebauten Loop wählen. Siehe [Der Loop Builder](the-loop-builder).
3. **Drück ▶ Play.**

Das war's. Die rail startet einen KI-CLI-Prozess im richtigen Ausführungskontext und legt mit der Pipeline los.

### Was im rail-Header steckt

| Element | Was es macht |
|---------|--------------|
| **Status-Pill** | `idle`, `running` oder `failed`. Es gibt kein eigenes „completed“ — eine rail kehrt auf `idle` zurück, wenn ihr Job sauber durchläuft. |
| **Spec-Liste** | Die IDs, die dieser rail zugewiesen sind. Zieh weitere hinein oder heraus, um sie wieder zu lösen. |
| **Loop-Auswahl** | Der Loop, den diese rail ausführt — ein eingebauter (`Implement` / `Batch` / `Freestyle`) oder ein eigener Loop. Siehe Tabelle unten. Pro rail gespeichert. |
| **Profil-Auswahl** | Welches Agent-Profil läuft (nur bei Claude-rails). Erscheint erst, wenn das Projekt mindestens ein Profil hat. |
| **Engine-Auswahl** | Welcher installierte Provider diese rail ausführt — Claude, Codex oder Gemini. Wird nur angezeigt, wenn das Projekt mehr als einen Provider hat. Siehe [Engine pro Rail wählen](picking-an-engine-per-rail). |
| **▶ Play / ■ Stop** | Starten oder abbrechen. |

### Was eine rail ausführt: Loops

Eine rail führt einen **Loop** aus — das Rezept für die Arbeit. Drei Loops sind **eingebaut** und decken die gängigen Fälle ab:

| Eingebauter Loop | Befehl | Was er macht |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | Ein Job für alle Specs auf der rail. Durchläuft die komplette Pipeline Architect → Developer → Reviewer → Ship. Der Alltagsstandard. |
| **Batch** | `/specrails:batch-implement` | Ein Job, der die Specs der rail nacheinander abarbeitet — in abhängigkeitsbewussten Wellen. Ideal für mehrere zusammenhängende Specs. |
| **Freestyle** | Freestyle | Claude implementiert jede Spec eigenständig und **umgeht** dabei die Pipeline. Ein unabhängiger Job pro Spec. Nur Claude. |

Freestyle ist der Sonderfall: Es überspringt die Agent-Kette und übergibt Claude die rohe Spec, an der es mit seinen nativen Tools arbeitet. Das ist offen angelegt, deshalb öffnet Play zuerst eine Bestätigung, und eine Modell-Auswahl pro rail lässt dich zwischen Haiku / Sonnet / Opus wählen. Es erscheint nur, wenn die Engine der rail Claude ist. Ein Freestyle-Lauf ist außerdem der einzige Job, der **für dich offen bleibt**: Chatte mit ihm über den Composer der Job-Detail-Ansicht und klicke auf **Finalize**, wenn du zufrieden bist (alle anderen Jobs schließen sich selbst ab).

Über die eingebauten Loops hinaus kannst du **deine eigenen Loops bauen** — einen verify → fix → verify-Zyklus wiederholen, bis ein Ziel erreicht ist, Shell-Befehle zwischen KI-Schritten verketten und mehr. Diese eigenen Loops erscheinen in derselben Loop-Auswahl. Das ist die nächste große Idee: [Der Loop Builder](the-loop-builder).

## Die Job-Queue

Jedes Mal, wenn du Play drückst, wird der rail-Lauf zu einem **Job**. Die wichtigste Regel, die du verinnerlichen solltest:

> **Rails laufen parallel.** Jeder Git-gestützte Start isoliert seine Arbeit in einem Git-Worktree pro Spec — mehrere rails können also gleichzeitig im selben Projekt laufen, ohne sich in die Quere zu kommen. Neue Arbeit endet in einer **In Prüfung**-Entscheidungskarte, über die du eine Draft-PR erstellen oder verwerfen kannst; Follow-up-Arbeit für eine Spec mit bereits offener PR setzt diese PR-Branch fort, statt erneut vom Integrations-Branch zu starten.

Du willst alles auf einmal starten? Der Button **Alle starten** im Rails-Header startet jede startbereite Spur in einem Rutsch — nach einer einzigen Bestätigung, die die Gesamtkosten einordnet (N rails × KI-Ausgaben). Leere, bereits laufende oder auf eine PR-Entscheidung wartende rails werden übersprungen und in einem kompakten Zusammenfassungs-Toast gemeldet. Der eingebaute Agent hat dieselbe Fähigkeit über `specrails_rails(launch_all)` — und legt eine frische rail an, wenn keine freie Spur existiert.

Projekte ohne Git haben keine Worktree-Isolation und keine PR-Fortsetzung. Sie können trotzdem laufen, aber die Rail schreibt direkt in den gemeinsamen Projektordner und das Ergebnis wird manuell über das Spec-Board akzeptiert oder zurückgenommen.

Es gibt keinen globalen Regler für die Parallelität. Die einzige automatische Bremse ist budgetbasiert: Wenn du ein Tagesbudget gesetzt hast (pro Projekt oder app-weit), pausiert die Queue von selbst, sobald die Ausgaben des Tages das Limit erreichen.

## Beim Laufen zusehen

Jeden Job findest du unter **Jobs** in der rechten Seitenleiste des Projekts — eine Kartenliste, die neuesten zuerst. Jede Karte zeigt ein Status-Badge, das Profil-Badge, ein Prioritäts-Badge, die Dauer, die Kosten und den gestarteten Befehl. Über der Liste:

- **Status-Filter-Chips** — zeigen nur Jobs in einem bestimmten Status.
- **Datumsbereich-Filter** — engt auf ein Zeitfenster ein.
- **Compare** — wähle zwei Jobs und betrachte sie nebeneinander.

Klick auf eine beliebige Karte, um die **Job-Detail-Ansicht** zu öffnen, in der das Live-Streaming-Log und die Live-Metriken stecken — und in der dir bei Claude-Jobs ein Chat-Composer erlaubt, **dem laufenden Agenten Fragen zu stellen oder ihn mitten im Lauf zu lenken**, ohne irgendetwas anzuhalten. Das ist die nächste Seite: [Die Job-Detail-Ansicht](the-job-detail-view).

## Einen Job abbrechen

Klick im rail-Header auf **■ Stop**. Die App sendet `SIGTERM` an den Subprozess, wartet **5 Sekunden** auf einen sauberen Ausstieg und schickt dann `SIGKILL`. Es bleibt nichts halb gestartet zurück.

## Wenn eine Rail nicht starten will

Wenn du eine Engine wählst, deren CLI nicht auf deinem Rechner installiert ist, **schlägt der Start sofort fehl**, anstatt einen kaputten Job zu starten — es wird nichts gestartet. Installiere die fehlende Provider-CLI ([Codex verwenden](../integrations/using-codex), [Gemini verwenden](../integrations/using-gemini)) und starte erneut. Ein fehlendes Claude oder Codex liefert eine präzise „*&lt;provider&gt; CLI not found*“-Meldung; ein fehlendes Gemini zeigt heute eine generische Startfehlermeldung, aber das Ergebnis ist dasselbe.

## Alles stoppen

Wenn etwas nicht stimmt:

- **Eine einzelne rail** — klick in ihrem Header auf **■ Stop**.
- **Auto-Pause beim Budget** — setze ein Tagesbudget, und die Queue pausiert sich selbst, sobald die Ausgaben des Tages das Limit erreichen.
- **Alles** — beende die Desktop-App oder führe `specrails-desktop stop` aus.

## Wie es weitergeht

- [Der Loop Builder](the-loop-builder) — was eine rail ausführt und wie du deine eigenen Loops baust.
- [Die Job-Detail-Ansicht](the-job-detail-view) — Phasen, Live-Metriken, Ticket-Karten.
- [Batch implement & Multi-Feature](batch-implement-and-multi-feature) — mehrere Specs auf einmal ausführen.
- [Engine pro Rail wählen](picking-an-engine-per-rail) — Claude vs. Codex vs. Gemini.
