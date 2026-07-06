# Batch implement & Multi-Feature

Eine Spec nach der anderen ist völlig okay, aber viel echte Arbeit kommt in Bündeln — ein Feature plus seine Tests plus seine Migration, oder ein Backlog, das du in einer Sitzung abräumen willst. Diese Seite zeigt, wie du mehrere Specs zusammen ausführst: den Batch-Modus, Abhängigkeits-Wellen und wie die Pipeline verhindert, dass gleichzeitige Arbeit miteinander kollidiert.

## Mehrere Specs auf einmal ausführen

Der einfachste Weg, einen ganzen Stapel Specs aus einer Rail laufen zu lassen, ist der **Batch**-Modus:

1. **Zieh alle Specs**, die du willst, auf eine einzige Rail. Sie stapeln sich in der Spec-Liste dieser Rail.
2. **Stell den Modus der Rail auf Batch** (die segmentierte Auswahl im Rail-Header).
3. **Drück ▶ Play.**

Die Rail startet **einen** `/specrails:batch-implement`-Job, der jede zugewiesene Spec abarbeitet. Beobachte ihn wie jeden anderen Job auf der Jobs-Seite — es ist ein einzelner Job für das gesamte Set, nicht ein Job pro Spec.

Der Batch-Modus bleibt der sauberste Weg, zusammenhängende Specs zu *sequenzieren*, weil ihre Abhängigkeitsreihenfolge in einer einzigen Rail bleibt. Wenn die Specs unabhängig sind, kannst du sie auch auf mehrere Rails verteilen: Git-gestützte Rails laufen parallel und jede bekommt ihren eigenen isolierten Worktree.

### Implement vs. Batch — welcher Modus?

| | **Implement** | **Batch** |
|---|---|---|
| Befehl | `/specrails:implement` | `/specrails:batch-implement` |
| Specs pro Job | Alle auf der Rail, als eine Arbeitseinheit behandelt | Alle auf der Rail, **nacheinander** abgearbeitet |
| Am besten für | Eine eng verzahnte Änderung | Mehrere eigenständige Features, die du der Reihe nach abräumen willst |
| Reihenfolge | n/v | Abhängigkeitsbewusste Wellen (siehe unten) |

Wenn die Specs wirklich eine Änderung sind, nimm **Implement**. Wenn sie eine Liste separater Features sind, nimm **Batch** und lass es sie sequenzieren.

## Abhängigkeits-Wellen

Der Batch-Modus arbeitet die Specs nicht einfach von oben nach unten ab — er berechnet eine **abhängigkeitsbewusste Ausführungsreihenfolge** und gruppiert die Specs in *Wellen*. Der Orchestrator (`/specrails:batch-implement`) ermittelt, welche Specs von welchen abhängen, und plant sie dann so ein, dass nichts vor der Arbeit läuft, auf der es aufbaut.

Konzeptionell:

```
Welle 1:  #2 (Datenmodell)         ← keine Abhängigkeiten, läuft zuerst
Welle 2:  #4 (API auf dem Modell)  ← wartet auf #2
          #5 (CLI auf dem Modell)  ← wartet auf #2
Welle 3:  #7 (Docs über alles)     ← wartet auf #4 und #5
```

Innerhalb des Jobs werden die Specs jeder Welle implementiert, bevor die nächste Welle beginnt. Du konfigurierst das nicht von Hand — der Orchestrator leitet die Wellen aus den Specs selbst ab. Sieh dabei zu, wie es sich in der [Job-Detail-Ansicht](the-job-detail-view) entfaltet: Das Streaming-Log erzählt, an welcher Spec der Batch gerade arbeitet, und der Ticket-Header zeigt jede Spec, die der Job berührt hat.

## Worktree-Isolation und wie die Arbeit ausgeliefert wird

Wenn in einem Lauf mehrere Specs implementiert werden, hält die Pipeline jede Arbeitseinheit isoliert, damit gleichzeitige oder aufeinanderfolgende Änderungen sich nicht gegenseitig die Dateien zertrampeln. Die Implementierung jeder Spec läuft in ihrem eigenen sauberen **git-Worktree** — einem separaten Checkout, der die Historie deines Repositories teilt, aber deinen Arbeitsbaum niemals berührt, während die KI arbeitet.

Wenn der Lauf fertig ist, **wird nichts gepusht und noch kein Pull-Request geöffnet**. Die Arbeit bleibt sicher auf ihren isolierten Branches committet, die Specs wechseln in einen neuen Status **In Prüfung**, und specrails **fragt dich zuerst**: Auf dem Rail erscheint eine persistente Entscheidungsleiste mit **PR erstellen** — ein einziger Entwurfs-Pull-Request von dem für dein Projekt festgelegten Integrations-Branch (lege ihn unter **Einstellungen → Integrations-Branch** fest; standardmäßig ist es der Default-Branch deines Repositories), kombiniert über alle Specs des Rails — und **Verwerfen**. specrails **merged niemals und committet niemals direkt auf deinen Integrations-Branch** — du entscheidest, ob überhaupt ein PR entsteht, und ein Mensch verantwortet den Merge. Das ist die sichere Übergabe: specrails erstellt den Pull-Request erst, wenn du es sagst, und deine Entwickler prüfen ihn und mergen ihn in GitHub genau so, wie sie es ohnehin schon tun.

Wenn du eine Spec erneut startest, die bereits in Prüfung ist und einen offenen Pull-Request hat, behandelt Specrails das als Follow-up-Arbeit. Es erkennt die aktive PR über seinen eigenen Lieferdatensatz oder über GitHub-/Jira-Referenzen, checkt die Head-Branch dieser PR aus, committet die neuen Änderungen dort und zeigt dieselbe PR-Karte wieder an. Neue Arbeit startet weiterhin vom Integrations-Branch.

In der Praxis heißt das:

- Jede Spec bekommt zum Implementieren eine saubere Ausgangslage, statt die noch laufenden Änderungen der vorherigen Spec mitten im Fluss zu erben.
- Dein Arbeitsbaum wird während des laufenden Durchgangs nie verändert — nichts landet, bevor du es freigibst.
- Wenn der Lauf fertig ist, zeigen die Specs ein **In Prüfung**-Abzeichen und das Rail stellt dir die Frage: **PR erstellen**, um den kombinierten Entwurfs-Pull-Request zu öffnen, oder **Verwerfen**, um die Branches aufzuräumen und die Specs ins Backlog zurückzulegen. Hast du das Rail aus dem Agenten-Chat gestartet, erscheint dieselbe Frage als Karte in dieser Konversation — antworte an einer der beiden Stellen, beide bleiben synchron.
- Nach dem Erstellen kannst du mit **PR öffnen** hineinsehen, mit **Veröffentlichen** ihn für das Review deines Teams öffnen und an das normale GitHub-Review übergeben, und **Merge prüfen** setzt die Specs auf Fertig, sobald dein Team ihn gemerged hat.
- Falls die isolierten Branches beim Erstellen des PR nicht sauber kombiniert werden können, stoppt specrails auf sichere Weise und überlässt die Branches einem Menschen — es erzwingt niemals einen kaputten Merge auf deinen Basis-Branch. Von derselben Leiste aus kannst du es erneut versuchen oder verwerfen.

> Für das Erstellen oder Fortsetzen einer PR brauchst du ein Git-Repository, eine authentifizierte GitHub-CLI (`gh`) und ein konfiguriertes Remote. Ohne `gh` oder Remote bleibt die Arbeit trotzdem auf einem Branch committet, von dem aus du selbst einen Pull-Request öffnen kannst — es geht nichts verloren, und die Entscheidungsleiste erlaubt einen erneuten Versuch. Ganz ohne Git gibt es keinen Branch-Graphen, den Specrails fortsetzen könnte: Die Rail läuft im gemeinsamen Ordner und es erscheint keine PR-Karte. Um auf das ältere Verhalten zurückzufallen (lokal integrieren, statt zu fragen), setze `SPECRAILS_RAIL_DELIVER_PR=0`.

## Multi-Feature über Projekte hinweg

Wenn du echte Parallelität willst, nutze mehrere Rails für unabhängige Specs im selben Git-gestützten Projekt oder teile die Arbeit über Projekte auf. Jede aktive Rail bekommt ihren eigenen isolierten Worktree, also:

```
Projekt A   ▶ Rail baut Feature X   ┐
                                    ├─ laufen gleichzeitig
Projekt B   ▶ Rail baut Feature Y   ┘
```

Es gibt kein globales Parallelitäts-Limit, das du einstellen musst. Öffne die Projekte oder Rails, die du brauchst, starte sie, und sie kommen zusammen voran. Die einzige geteilte Bremse ist dein Budget-Limit, das die Queues pro Projekt oder app-weit pausiert, sobald die Ausgaben des Tages das Limit erreichen.

## Tipps für große Batches

- **Gruppiere verwandte Specs auf einer Rail**, bevor du auf Batch umstellst — die Abhängigkeits-Wellen sehen nur, was auf dieser Rail liegt.
- **Setze ein Tagesbudget**, bevor du einen großen Batch startest, damit ein unerwartet teurer Lauf automatisch pausiert, statt davonzulaufen. Konfiguriere es unter [Budget](../settings/customizing).
- **Nutze danach den Compare-Button** auf der Jobs-Seite, um zwei Batch-Läufe nebeneinander zu vergleichen.
- **Exportiere eine Diagnose** (falls Telemetrie an war), um den exakten Profil- und Plugin-Snapshot für den gesamten Batch zu erhalten.

## Wie es weitergeht

- [Rails & Jobs](rails-and-jobs) — das Queue-Modell im Detail.
- [Die Job-Detail-Ansicht](the-job-detail-view) — einem Batch-Lauf live zusehen.
- [Engine pro Rail wählen](picking-an-engine-per-rail) — beachte: Batch läuft auf jedem Provider; Freestyle gibt es nur bei Claude.
