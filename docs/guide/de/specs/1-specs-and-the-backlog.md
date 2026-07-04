# Specs & das Backlog

Eine **Spec** ist die Arbeitseinheit, die die KI-Pipeline umsetzt. Stell sie dir wie ein Ticket vor: ein Titel, eine Beschreibung dessen, was du erledigt haben möchtest, eine Priorität und optionale Labels. Wenn du die Pipeline startest, lesen die KI-Agenten die Spec und handeln danach – eine klare Spec ist also der mit Abstand wichtigste Input für ein gutes Ergebnis.

Specs werden in der App manchmal auch **Tickets** genannt – beide Begriffe meinen dasselbe.

## Das Board

Jedes Projekt öffnet sich auf seinem **Dashboard**, das das **SpecsBoard** zeigt – die Liste aller Specs des Projekts. Das ist dein Backlog. Von hier aus erstellst du neue Specs, legst ihre Priorität fest, ziehst sie auf eine Rail, um sie umzusetzen, und beobachtest, wie sich ihr Status während der Arbeit ändert.

Das Board hat zwei Ansichtsmodi, die du über einen Umschalter in der Toolbar wechselst und die pro Projekt gemerkt werden:

- **Post-it-Ansicht** (Standard) – kartenartige Kacheln mit kurzen Zusammenfassungen.
- **Listenansicht** – kompakte, einzeilige Zeilen.

Der **Status-Selektor** in der Werkzeugleiste zeigt jeden Status als eigenen Chip mit Live-Zähler — plus zwei smarte Gruppen: **Aktiv** (der Standard — alles, was noch in Bewegung ist: Entwürfe, To-dos, in Arbeit und in Prüfung) und **Alle** (alles, mit Fertig unten angeheftet). Deine Auswahl wird pro Projekt gemerkt und in die URL gespiegelt, sodass ein Neuladen oder ein geteilter Link exakt dieselbe Ansicht wiederherstellt. Bei Jira-verbundenen Projekten erscheint zusätzlich ein **Jira-Status**-Dropdown mit den *echten* Workflow-Status des Boards (ihre Rohnamen, z. B. „Code Review", jeweils mit Live-Zähler), gruppiert unter dem Zustand, auf den sie abbilden — es kombiniert sich mit den Status-Chips. Du kannst außerdem nach **Label** filtern sowie nach **Standard**, **Ticket #** oder **Priorität** sortieren (jeweils mit Umschalter für auf- und absteigend).

## Status

Eine Spec durchläuft eine überschaubare Reihe von Status. Das Board gibt jedem davon einen einheitlichen visuellen Hinweis, damit du den Zustand deines Backlogs auf einen Blick erfassen kannst:

| Status | Bedeutung |
|--------|-----------|
| **Entwurf** | Eine noch in Arbeit befindliche Idee, die aus einer Explore-Unterhaltung gespeichert wurde. Noch nicht bereit zur Umsetzung – du kannst zurückkommen und sie weiter ausarbeiten. Zeigt ein `Draft`-Pill. |
| **To-do** | Bereit, in Angriff genommen zu werden. Hier landet eine fertige Spec, wenn du sie erstellst. |
| **In Arbeit** | Die Pipeline arbeitet gerade daran (ein pulsierender blauer Punkt). |
| **In Prüfung** | Implementiert — jeder abgeschlossene Lauf parkt seine Specs hier zur Freigabe: merge die Entwurfs-PR oder verschiebe sie selbst weiter (ein bernsteinfarbenes Pill). |
| **Fertig** | Freigegeben — die PR wurde gemergt, oder du hast sie selbst hierher verschoben (ein grünes Häkchen). |
| **Abgebrochen** | Verworfen (ein rotes X). |

Entwürfe liegen im selben aktiven Bereich wie To-do-Specs – es gibt keine eigene Spalte für sie –, tragen aber einen dezent eingefärbten Rand und ein `Draft`-Pill, sodass sie leicht zu erkennen sind. Die ganze Geschichte rund um Entwürfe findest du unter [Entwürfe & der Contract Layer](drafts-and-contract-layer.md).

## Prioritäten

Jede Spec, die kein Entwurf ist, hat eine Priorität: **Kritisch**, **Hoch**, **Mittel** oder **Niedrig**. Die Priorität ist rein ein Ordnungswerkzeug – sie hilft dir zu entscheiden, was du als Nächstes umsetzt, und erlaubt dir, das Board zu sortieren. Du legst sie beim Erstellen einer Spec fest und kannst sie jederzeit ändern, indem du mit der rechten Maustaste auf die Spec-Karte klickst und **Priorität festlegen** wählst.

Entwürfe sind die einzige Ausnahme: Ein Entwurf darf *gar keine* Priorität haben, weil er noch eine Idee in Arbeit ist. Die Priorität wird festgelegt, sobald du den Entwurf in eine echte Spec überführst.

## Eine Spec erstellen

Um eine Spec zu erstellen, klicke auf **Hinzufügen** (die Plus-Schaltfläche in der SpecsBoard-Toolbar). Der Dialog **Spec hinzufügen** öffnet sich mit mehreren Arbeitsweisen:

- **Quick-Modus** – du beschreibst, was du möchtest, und die KI schreibt die vollständige Spec in einem Rutsch. Siehe [Spec hinzufügen – Quick-Modus](add-spec-quick-mode.md).
- **Explore-Modus** – du unterhältst dich mit der KI, und sie hilft dir, die Spec Zug um Zug zu formen. Siehe [Spec hinzufügen – Explore-Modus](add-spec-explore-mode.md).
- **Raw-Modus** – was auch immer du eintippst, wird wortwörtlich als Spec gespeichert, ganz ohne KI. Nutze ihn, wenn du den Spec-Text bereits geschrieben hast.

Welchen du wählst, hängt davon ab, wie klar die Idee schon ist. Du weißt genau, was du willst? Quick. Du tüftelst noch daran? Explore. Du hast den Text schon? Raw.

## Wie es weitergeht

- [Spec hinzufügen – Quick-Modus](add-spec-quick-mode.md) – der schnellste Weg, eine Idee in eine Spec zu verwandeln.
- [Spec hinzufügen – Explore-Modus](add-spec-explore-mode.md) – eine Spec im Gespräch formen.
- [Entwürfe & der Contract Layer](drafts-and-contract-layer.md) – Arbeit zwischenspeichern und Specs für die Pipeline anreichern.
