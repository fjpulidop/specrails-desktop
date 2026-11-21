# Wo deine Daten liegen

Kurz gesagt: **Specrails hält deine Repositories sauber.** Wenn du die App auf eines deiner Projekte richtest, zieht sie nicht bei dir ein, streut keine Konfigurationsdateien wild umher und schreibt nichts um, worum du nicht gebeten hast. Dein Code bleibt deiner – und bleibt sauber.

## Dein Repository bleibt sauber

Specrails' eigene Dateien – seine Datenbanken, der projektspezifische Zustand, die Agent-Definitionen, Einstellungen, Telemetrie, Zusammenfassungen und alles andere, was es zum Laufen braucht – liegen an einem einzigen, ordentlichen Ort in deinem Home-Verzeichnis:

```
~/.specrails/
```

**Einstellungen ▸ Über** zeigt den genauen Speicherort der Datenbank und die Version der App, die du verwendest.

Dieser Ordner ist der private Arbeitsbereich der App. Hier leben die Projektregistrierung, die projektspezifischen Datenbanken, die mitgelieferten Tools und alle betrieblichen Bestandteile. Deine eigentlichen Code-Repositories werden für nichts davon als Ablageplatz missbraucht.

Das bedeutet:

- Die `.gitignore` deines Repositorys wird von der App **nicht** umgeschrieben.
- Dein Repository wird nicht mit Tool-Konfigurationen oder versteckten Zustandsverzeichnissen vollgemüllt.
- Wenn du ein Projekt aus Specrails entfernst, bleibt kein Durcheinander in deinem Code zurück.

Falls du schon Tools genutzt hast, die klammheimlich überall in deinem Projekt Ordner und Dateien angelegt haben: Das hier ist ein bewusster Gegenentwurf. Specrails ist so gebaut, dass es für die git-Historie eines Repositorys ein **Nicht-Ereignis** ist, die App darauf zu richten.

## Das eine, was *doch* committet wird – mit Absicht

Es gibt genau eine bewusste Ausnahme, und sie ist der ganze Sinn des Tools: **deine OpenSpec-Specs.**

Specs leben in deinem Repository, und zwar unter:

```
openspec/
```

Das ist Absicht. Deine Specs sind ein **Ergebnis** – eine versionierte, überprüfbare Aufzeichnung dessen, was du bauen wolltest und warum. Sie gehören neben deinen Code, nachverfolgt in git, sichtbar in Pull Requests, geteilt mit deinem Team. Genau darin liegt der Wert: Specs sind kein wegwerfbarer Zwischenstand, sondern Teil der Geschichte deines Projekts.

Die Regel ist also einfach und ehrlich:

- **`openspec/`** → liegt in deinem Repository, wird committet, mit Absicht.
- **Alles andere, was Specrails braucht** → liegt unter `~/.specrails/`, dir aus dem Weg.

## Warum das so funktioniert

Specrails führt die AI-Tools aus seinem eigenen privaten Arbeitsbereich aus (unter `~/.specrails/`) und greift nur für die Dinge in dein echtes Repository zurück, die es wirklich berühren müssen – deinen Code lesen und die Specs schreiben, um die du gebeten hast. Die Tools, die Framework-Definitionen und die Buchführung bleiben allesamt im Home-Ordner der App.

Was das für dich bedeutet: Du kannst ein Projekt hinzufügen, Pipelines laufen lassen, Specs erkunden und Dinge ausprobieren – in der Gewissheit, dass sich Working Tree und git-Historie deines Repositorys immer nur auf die Weise ändern, die du erwartest – deine committeten Specs und der Code, den deine Pipelines schreiben. Sonst schleicht sich nichts ein.

## Ein Projekt entfernen

Wenn du ein Projekt aus Specrails entfernst, räumt die App ihren eigenen projektspezifischen Zustand unter `~/.specrails/` auf. Die Specs, die bereits in dein Repository committet wurden, bleiben dort, wo sie hingehören – in deinem Repository –, denn sie gehören dir.

## Auf der Festplatte behaltene Run-Worktrees {#retained-worktrees}

Jeder Rail-Run arbeitet in einem eigenen Git-Worktree unter `~/.specrails/projects/<Projekt>/worktrees/`. Wenn ein Run abgeschlossen ist, entfernt Specrails diesen Worktree, aber nur, wenn es beweisen kann, dass nichts verloren geht. Kann es das nicht (nicht committete Änderungen, Dateien, die es nur dort gibt, oder ein fehlgeschlagenes Entfernen), behält es den Worktree. Mit der Zeit sammeln sie sich an.

**Einstellungen ▸ Speicher** listet sie für alle Projekte auf. Du erreichst die Liste auch über das Popover **App-Ressourcen** in der Statusleiste. Jeder Worktree zeigt seine Größe (im Hintergrund gemessen), wie lange er ungenutzt ist, seinen PR und was beim Entfernen verloren ginge:

- **Nichts zu verlieren**: keine nicht committeten Änderungen, und jede ignorierte Datei ist wiederherstellbar (`node_modules`), ein Link oder identisch mit derselben Datei in deinem Haupt-Checkout (zum Beispiel eine kopierte `.env`). Jeder Commit seines Branches liegt auf einem Remote oder einem anderen Branch, oder seine Lieferung wurde gemergt.
- **Wartet auf dich**: Etwas braucht noch dich. Jeder Grund wird genannt: nicht committete Änderungen, ignorierte Dateien, die es nur dort gibt, Commits nur auf diesem Branch, eine Lieferung, die noch auf deine Entscheidung wartet, kürzliche Aktivität (die letzte Stunde) oder dass Git ihn nicht prüfen konnte. Kann Git einen Worktree nicht prüfen, gilt er nie als sauber.

Wähle Worktrees aus und klicke auf **Entfernen**. Die Bestätigung zeigt, wie viel Speicher du zurückbekommst und was mit den Branches passiert:

- Branches werden standardmäßig **behalten**, ihre Commits bleiben also verfügbar.
- Mit **Auch Branches löschen, die nichts Neues enthalten** wird ein Branch nur gelöscht, wenn er nichts zu verlieren hat, und nur, wenn er noch auf den von Specrails geprüften Commit zeigt.

Worktrees mit nicht committeten Änderungen oder Dateien, die es nur dort gibt, lassen sich nicht auswählen. Committe, kopiere oder verwirf diese Arbeit zuerst. Ein Worktree, der zu einer Intent-Sitzung gehört, wird angezeigt, aber in seiner Sitzung behandelt. Direkt vor dem Entfernen wird jeder Worktree erneut geprüft: Hat sich nach deiner Bestätigung etwas geändert, bleibt er erhalten, und das Ergebnis sagt warum. Prozesse, die in einem entfernten Worktree noch liefen (zum Beispiel ein Dev-Server), werden beendet.

## Außerhalb eines PR aufbewahrte Dateien {#safety-archives}

Während ein Run arbeitet, legt Specrails einige eigene Dateien in den Worktree: die Projektanweisungen (`CLAUDE.md`), lokale Einstellungen mit seinem Sicherheits-Hook und Links auf seine Befehle und Skills. Sie kommen nie in den PR. Wenn der Worktree entfernt wird, löscht Specrails sie, sofern sie genau so sind, wie es sie geschrieben hat. Ein normaler Run hinterlässt also nichts.

Hat sich eine davon geändert (ein Agent hat zum Beispiel `CLAUDE.md` bearbeitet) oder kann Specrails nicht belegen, dass eine Datei von ihm stammt, löscht es sie nicht. Es verschiebt sie in einen Ordner neben dem Worktree (`<worktree>.specrails-overlay-quarantine-…`), und die PR-Karte meldet **N Dateien wurden aufbewahrt, die nicht in den PR kamen**:

- **Details** zeigt den Ordner (mit **Pfad kopieren** und **Im Finder zeigen**) und jede aufbewahrte Datei mit ihrer Größe.
- **Löschen** fragt vorher nach, nennt den Ordner und die Anzahl der Dateien und löscht nur diesen Ordner.
- **Ausblenden** blendet den Hinweis aus. Die Dateien bleiben, wo sie sind.

**Einstellungen ▸ Speicher ▸ Außerhalb eines PR aufbewahrte Dateien** listet alle diese Ordner aller Projekte mit Größe und Alter. Wähle mehrere aus und lösche sie in einem Schritt. Specrails löscht nur einen Ordner mit genau diesem Namen im Worktree-Bereich des jeweiligen Projekts und folgt nie Links nach außen.
