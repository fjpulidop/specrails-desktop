# Der Loop Builder

Eine **rail führt einen Loop aus**. Die eingebauten Loops (`Implement`, `Batch`, `Freestyle`) decken die Alltagsfälle ab, aber der **Loop Builder** lässt dich deine eigenen entwerfen — ein visueller Editor im n8n-Stil für Automatisierung, die sich wiederholt, bis ein Ziel erreicht ist. Diese Seite erklärt, was ein Loop ist, wie du einen baust und wie du ihn auf einer rail ausführst.

## Loops und rails — die Beziehung

Ein **Loop** ist das *Rezept* für die Arbeit; eine **rail** ist die *Spur*, die es gegen deine Specs ausführt.

```
   Loop Builder (linke Seitenleiste)        Rails (rechts)
   ───────────────────────────             ─────────────
   Implement   (eingebaut)                  Rail 1
   Batch       (eingebaut)     wählen auf ►    Loop: Verify-until-green
   Freestyle   (eingebaut)                     ▶ Play
   Verify-until-green (deiner)
```

- Loops leben im **Loops**-Bereich (linke Seitenleiste, neben deinen Projekten) — sie sind **global**, projektübergreifend geteilt.
- Eine rail **wählt einen Loop** in ihrem Header (der Loop-Picker) und führt ihn aus, wenn du Play drückst.
- Die **rail** entscheidet über Provider, Modell und Reasoning-Aufwand — *nicht* die Schritte des Loops. Derselbe Loop läuft auf Claude, Codex oder Gemini, je nach rail.

Also: Bau einen Loop einmal, dann wähl ihn auf jeder rail in jedem Projekt.

## Den Builder öffnen

Klick **Loops** in der linken Seitenleiste, um die Bibliothek zu sehen: die drei eingebauten Loops plus alle deine eigenen. Öffne einen, um ihn anzusehen, oder klick **New loop**, um mit einer leeren Leinwand zu starten.

Einen eingebauten Loop kannst du nicht ohne Weiteres direkt bearbeiten — stattdessen **Fork** ihn. Das gibt dir eine bearbeitbare Kopie eines funktionierenden Graphen als Ausgangspunkt, was der einfachste Weg zum Lernen ist.

## Woraus ein Loop besteht

Ein Loop ist ein Graph aus **Knoten**, verbunden durch **Kanten** (die Pfeile). Jeder Knoten ist ein Schritt:

| Knoten | Was er macht |
|------|--------------|
| **Start** | Wo der Lauf beginnt. Genau einer pro Loop. |
| **AI Step** | Führt einen KI-Durchgang aus — ein Prompt, den du schreibst, oder ein *magischer Befehl* wie `{{cmd:implement}}`, `{{cmd:verify}}`, `{{cmd:fix}}`. Hier passiert die eigentliche Arbeit. |
| **Shell** | Führt einen Shell-Befehl aus (z. B. `npm test`) und erfasst dessen Ausgabe für spätere Schritte. |
| **Loop Decider** | Das Hirn eines Loops. Bei jedem Durchgang liest er ein **Ziel**, das du schreibst, und entscheidet **continue** (zurückschleifen und erneut versuchen) oder **stop** (beenden). Das ist es, was *verify → fix → verify until green* antreibt. |
| **End** | Ein Endknoten. Markiert den Lauf als Erfolg oder Misserfolg. |

Kanten verbinden die Schritte der Reihe nach. Der **Loop Decider** hat zwei beschriftete Ausgänge — **continue** und **stop** — also verdrahtest du „noch nicht fertig" zurück in die Arbeit und „fertig" hinaus zu einem End.

### Schritt-Text schreiben

Innerhalb jedes AI Step oder Decider kannst du referenzieren:

- **Spec-Daten** — `{{spec.title}}`, `{{spec.description}}`, `{{spec.ids}}` (die Ticket-IDs der rail). Werden zur Laufzeit aus der/den Spec(s) auf der rail eingesetzt.
- **Magische Befehle** — `{{cmd:implement}}` und Konsorten expandieren zum passenden Pipeline-Befehl.
- **Konstanten** — `{{const:NAME}}` zieht aus der globalen **Konstanten-Bibliothek** (zieh sie aus der Palette herein). Eingebaute Sentinels wie die PASS/FAIL-Marker der Verifizierung sind immer verfügbar; du kannst eigene hinzufügen und sie über jeden Loop hinweg wiederverwenden.

## Einen Loop begrenzt halten

Ein Loop, der nie stoppt, würde ewig Geld verbrennen, also hat jeder Lauf drei Schutzmechanismen (in der Builder-Toolbar gesetzt):

| Schutz | Was er macht |
|-------|--------------|
| **Max iterations** | Harte Obergrenze, wie oft der Decider zurückschleifen darf, unabhängig von seinem Urteil. |
| **Timeout (min)** | Echtzeit-Limit für den gesamten Lauf. |
| **Max cost ($)** | *Optional.* Stoppt den Loop, sobald die aufgelaufenen Kosten dein Budget überschreiten. Wird **zwischen Schritten** geprüft (die Kosten eines Schritts sind erst bekannt, wenn er fertig ist), kann also um einen Schritt überschießen. Auf Claude sind die Kosten exakt; auf Codex und Gemini sind sie eine Schätzung. Lass es leer für keine Obergrenze. |

## Mit Sicherheit bauen

Der Builder hilft dir, einen Loop richtig hinzubekommen, bevor er überhaupt läuft:

- **Live-Validierung** — Probleme (kein Start, ein verwaister Schritt, ein leerer Prompt, ein Decider mit fehlenden Zweigen) werden auf der Leinwand und in einem Problem-Panel markiert.
- **Dry-Run-Vorschau** — löst den exakten Text jedes Schritts auf (Spec-Daten, Konstanten, Befehle alle expandiert), **ohne irgendetwas zu starten**, sodass du genau siehst, was jeder Schritt senden würde.
- **Auto-Anordnen** — räum die Leinwand vertikal, horizontal oder als Gitter auf; deine Wahl wird pro Loop gespeichert.
- **Kopieren / Einfügen** — `Cmd/Ctrl + C` / `V`, um Schritte innerhalb oder zwischen Loops zu kopieren.
- **Import / Export** — speichere Loops in eine `.json`-Datei und importiere sie zurück (doppelte Namen werden übersprungen, der Rest wird importiert).
- **Schritte umbenennen** — gib jedem Knoten ein eigenes Label, damit der Graph klar lesbar ist.

## Veröffentlichen und ausführen

Ein Loop startet als **Draft**. Wenn der Graph gültig ist, **Publish** ihn — veröffentlichte Loops sind die, die im Loop-Picker einer rail erscheinen. (Unpublish, um ihn aus dem Verkehr zu ziehen, ohne ihn zu löschen.)

Um einen eigenen Loop auszuführen:

1. Öffne ein Projekt und zieh eine Spec auf eine rail.
2. Öffne im rail-Header den **Loop-Picker** und wähl deinen veröffentlichten Loop.
3. Drück **▶ Play**.

Der Lauf streamt live in der **Jobs**-Ansicht, mit denselben Metriken und derselben Kostenverfolgung wie jeder rail-Job — und sein Log bekommt einen eigenen **Schritt-Explorer**: eine Live-Karte deines Graphen mit einer aufklappbaren Box pro Schritt, die dem laufenden Schritt folgt, während der Loop voranschreitet (siehe [Die Job-Detail-Ansicht](the-job-detail-view)). Auf Claude ist jeder **KI-Schritt** zudem eine Live-Session: Schick ihm Nachrichten über den Composer der Job-Detail-Ansicht, um ihn mitten im Schritt zu lenken (zwischen den Schritten wartet der Composer kurz, und **Diesen Schritt abschließen** lässt den Loop mit dem Erreichten weiterziehen). Ein Loop, der stoppt, weil er seine Iterations- oder Kostenobergrenze erreicht hat, wird mit diesem Ergebnis gemeldet statt mit einem schlichten Erfolg.

> **Achtung, solange ein Loop läuft.** Du kannst einen Loop nicht bearbeiten oder löschen, während einer seiner Läufe gerade ausgeführt wird — stopp den Lauf zuerst.

## Wie es weitergeht

- [Rails & Jobs](rails-and-jobs) — rails starten und die Job-Queue.
- [Die Job-Detail-Ansicht](the-job-detail-view) — einem Lauf live zusehen.
- [Eine Engine pro Rail wählen](picking-an-engine-per-rail) — die rail (nicht der Loop) wählt den Provider.
