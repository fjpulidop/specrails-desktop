# Wo deine Daten liegen

Kurz gesagt: **Specrails hält deine Repositories sauber.** Wenn du die App auf eines deiner Projekte richtest, zieht sie nicht bei dir ein, streut keine Konfigurationsdateien wild umher und schreibt nichts um, worum du nicht gebeten hast. Dein Code bleibt deiner – und bleibt sauber.

## Dein Repository bleibt sauber

Specrails' eigene Dateien – seine Datenbanken, der projektspezifische Zustand, die Agent-Definitionen, Einstellungen, Telemetrie, Zusammenfassungen und alles andere, was es zum Laufen braucht – liegen an einem einzigen, ordentlichen Ort in deinem Home-Verzeichnis:

```
~/.specrails/
```

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
