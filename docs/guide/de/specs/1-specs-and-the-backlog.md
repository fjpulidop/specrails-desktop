# Specs & das Backlog {#specs-backlog}

Eine **Spec** ist die Arbeitseinheit, die die KI-Pipeline umsetzt. Stell sie dir wie ein Ticket vor: ein Titel, eine Beschreibung dessen, was du erledigt haben möchtest, eine Priorität und optionale Labels. Wenn du die Pipeline startest, lesen die KI-Agenten die Spec und handeln danach – eine klare Spec ist also der mit Abstand wichtigste Input für ein gutes Ergebnis.

Specs werden in der App manchmal auch **Tickets** genannt – beide Begriffe meinen dasselbe.

## Das Board

Jedes Projekt öffnet sich auf seinem **Dashboard**, das das **SpecsBoard** zeigt – die Liste aller Specs des Projekts. Das ist dein Backlog. Von hier aus erstellst du neue Specs, legst ihre Priorität fest, ziehst sie auf eine Rail, um sie umzusetzen, und beobachtest, wie sich ihr Status während der Arbeit ändert.

Das Board hat zwei Ansichtsmodi, die du über einen Umschalter in der Toolbar wechselst und die pro Projekt gemerkt werden:

- **Post-it-Ansicht** (Standard) – kartenartige Kacheln mit kurzen Zusammenfassungen.
- **Listenansicht** – kompakte, einzeilige Zeilen.

Die Specs-Werkzeugleiste hat zwei Zeilen. Die erste enthält ein **Suchfeld** (mit `/` springst du hinein; es findet Titel, `#Nummer`, Label oder Jira-Schlüssel), eine einzige **Filter**-Schaltfläche, die Sortier- und Ansichtssteuerung sowie **Neue Spec**. Die zweite Zeile ist der **Status-Selektor**: jeder Status als eigenes Segment mit Live-Zähler, dazu zwei smarte Gruppen, **Aktiv** (der Standard: alles, was noch in Bewegung ist, also Entwürfe, To-dos, in Arbeit und in Prüfung) und **Alle** (alles, mit Fertig unten angeheftet). Ist die Spalte schmal, wandern die seltener genutzten Status in ein **Mehr**-Menü, und der gewählte Status bleibt immer sichtbar. Deine Auswahl wird pro Projekt gemerkt und in die URL gespiegelt, sodass ein Neuladen oder ein geteilter Link exakt dieselbe Ansicht wiederherstellt. **Filter** öffnet ein Panel mit einem Abschnitt pro Dimension: **Labels** (Mehrfachauswahl) und bei Jira-verbundenen Projekten **Epic**, **Sprint** und **Jira-Status** (die *echten* Workflow-Status des Boards, z. B. „Code Review“, gruppiert unter dem Zustand, auf den sie abbilden, kombiniert mit dem Status-Selektor). Solange eine Suche oder ein Filter das Board eingrenzt, zeigt eine dritte Zeile jeden davon als entfernbaren Chip, nennt „x von y“ Specs und bietet **Alle zurücksetzen** (dein gewählter Status bleibt erhalten). Sortiere nach **Standard**, **Ticket #** oder **Priorität**, jeweils mit Umschalter für auf- und absteigend.

### Mehrere Specs auswählen

Sortieren Sie gesammelt statt Spec für Spec. Drücken Sie `x` auf einer fokussierten Karte, klicken Sie mit `Strg`/`⌘` auf eine Karte oder mit `Umschalt` für einen Bereich (ein Bereich bleibt in einer Spalte: die aktiven Specs oder der Bereich „Erledigt“). `Strg`/`⌘`+`A` wählt die ganze Spalte, in der Sie sind, `Esc` hebt die Auswahl auf. Jede Karte zeigt beim Darüberfahren oder Fokussieren ein Kontrollkästchen, ausgewählte Karten haben einen hervorgehobenen Rahmen. Keine dieser Tasten wirkt, solange Sie im Suchfeld tippen.

Sobald eine Spec ausgewählt ist, erscheint unten im Board eine schwebende Leiste mit der Anzahl und den Aktionen:

- **Verschieben nach** ändert den Status. Lokale Specs erhalten die lokalen Status; Specs aus Jira erhalten die echten Workflow-Status des Jira-Boards und laufen über dieselbe Jira-Warteschlange wie eine einzelne Verschiebung.
- **Label** fügt der Auswahl ein Label hinzu oder entfernt eines, das die Specs tragen.
- **Priorität** setzt für alle dieselbe Priorität.
- **Zu Rail hinzufügen** legt die Auswahl auf einen Rail.
- **Alle starten** gibt jeder ausgewählten Spec einen eigenen freien Rail und startet sie parallel, nach derselben Bestätigung und Prüfung des Tagesbudgets wie *Alle starten* bei den Rails. Specs, die noch nicht starten können (etwa im Review ohne offenen PR) oder keinen freien Rail finden, werden übersprungen und in der Zusammenfassung gezählt.
- **Löschen** verschiebt sie nach *Zuletzt gelöscht*.
- **Aufheben** (oder `Esc`) verwirft die Auswahl.

Löschen sowie Änderungen von Status, Labels und Priorität lassen sich in einem Schritt rückgängig machen: eine einzige *Rückgängig*-Meldung (oder `⌘Z`) stellt jede geänderte Spec wieder her. Schlagen einzelne fehl, nennt eine Meldung, wie viele geklappt haben und wie viele nicht. Die Auswahl enthält nur Specs, die Sie sehen: Ein Filter, der eine ausgewählte Spec ausblendet, nimmt sie aus der Auswahl.

### Gespeicherte Ansichten

Die Schaltfläche **Ansichten** neben **Filter** speichert das Board so, wie es gerade ist: die Statusauswahl, die Filter, die Sortierung und die Dichte (nicht den Suchtext). Wählen Sie **Aktuelle Ansicht speichern…**, geben Sie ihr einen Namen („Startbereit“, „Sprint 42“, „Diese Woche fehlgeschlagen“) und wählen Sie sie später im selben Menü. **Ansichten verwalten…** benennt eine Ansicht um, aktualisiert sie mit dem aktuellen Board, kopiert ihren Link oder löscht sie. Ansichten gehören zum Projekt. Ein kopierter Link (`?view=…`) wendet die Ansicht an, wenn er in dieser App geöffnet wird, und die Befehlspalette (`⌘K`) kann die aktuelle Ansicht speichern oder zu einer anderen wechseln.

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

Um eine Spec zu erstellen, klicke auf **Neue Spec** (die Plus-Schaltfläche in der SpecsBoard-Toolbar). Der Dialog **Spec hinzufügen** öffnet sich mit mehreren Arbeitsweisen:

- **Quick-Modus** – du beschreibst, was du möchtest, und die KI schreibt die vollständige Spec in einem Rutsch. Siehe [Spec hinzufügen – Quick-Modus](add-spec-quick-mode.md).
- **Explore-Modus** – du unterhältst dich mit der KI, und sie hilft dir, die Spec Zug um Zug zu formen. Siehe [Spec hinzufügen – Explore-Modus](add-spec-explore-mode.md).
- **Raw-Modus** – was auch immer du eintippst, wird wortwörtlich als Spec gespeichert, ganz ohne KI. Nutze ihn, wenn du den Spec-Text bereits geschrieben hast.

Welchen du wählst, hängt davon ab, wie klar die Idee schon ist. Du weißt genau, was du willst? Quick. Du tüftelst noch daran? Explore. Du hast den Text schon? Raw.

## Addenda – an einer bestehenden Spec iterieren

Wenn hinter einer Spec bereits Arbeit steckt – ein PR im Review, ein gemergtes Feature – und du *mehr* willst, schreibe ihre Beschreibung nicht um: Das verfälscht die Spec (und synchronisiert die Abweichung nach Jira) und zwingt den nächsten Lauf, alles neu zu planen. Öffne die Spec und füge stattdessen ein **Addendum** hinzu: eine kurze Notiz mit einer Art (Änderungswunsch, Review-Feedback, Klarstellung, Einschränkung) und deinen Worten. Offene Addenda reisen automatisch mit dem nächsten Start dieser Spec auf jedem Loop mit – Implement, SDD Quick, Freestyle –, sodass der Lauf nur ändert, was du verlangt hast, und das Review-Paket jedes als angewendet, teilweise angewendet oder blockiert meldet. Schlägt der Lauf fehl oder verwirfst du die Lieferung, kehren sie von selbst zu **Offen** zurück. Der Missions-Agent kann sie für dich anlegen, wenn du ihn bittest, etwas an einer bestehenden Spec zu ändern.

## Eine Lieferung prüfen – worauf zuerst achten

Wenn ein Lauf endet, beginnt sein Review-Paket mit **Worauf achten**: den kurzen Hinweisen des KI-Reviewers, die die riskantesten Stellen zuerst nennen (hoch, dann mittel, dann niedrig, jeweils mit Datei und Zeile), das Verhalten, das sich ändert, die Regeln, auf die sich die Änderung stützt, die Codepfade, die kein Test ausführt, und die Prüfungen, die nur ein Mensch machen kann. Dieselben Risiken, ungetesteten Pfade und Prüfungen stehen in einem kurzen Block oben im Pull Request, und die Missionskarte zeigt das größte Risiko in einer Zeile. Die Hinweise unterstützen Ihr Review, sie sind kein Prüfergebnis und blockieren Annehmen nie. Läufe mit einem älteren Specrails Core haben keine Hinweise; ihr Paket sieht aus wie bisher.

## Rückgängig und Zuletzt gelöscht {#recently-deleted}

Eine Spec löschen, ihren Status ändern, ihre Labels ändern oder sie von einer Rail nehmen geschieht sofort — ohne vorherige Rückfrage. Stattdessen bietet ein Hinweis etwa acht Sekunden lang **Rückgängig** an, und **⌘Z** (**Strg+Z** unter Windows und Linux) tut dasselbe, solange du nicht in einem Feld tippst. Rückgängig gilt pro Projekt: Ein Projektwechsel beendet das Zeitfenster.

Eine gelöschte Spec (und eine gelöschte Mission) ist nicht weg. Sie landet unter **Einstellungen → Zuletzt gelöscht** in den Projekteinstellungen, wo du sie 30 Tage lang **Wiederherstellen** oder **Endgültig löschen** kannst — Letzteres fragt nach. Nach 30 Tagen wird sie endgültig entfernt. Nicht gepushte Arbeit verwerfen, einen Pull Request erzwungen schließen und ein Projekt entfernen fragen weiterhin nach, weil sie sich nicht rückgängig machen lassen. Eine Jira-gestützte Spec wird weiterhin mit **Verschieben nach** statt durch Löschen bearbeitet.

## Wie es weitergeht

- [Spec hinzufügen – Quick-Modus](add-spec-quick-mode.md) – der schnellste Weg, eine Idee in eine Spec zu verwandeln.
- [Spec hinzufügen – Explore-Modus](add-spec-explore-mode.md) – eine Spec im Gespräch formen.
- [Entwürfe & der Contract Layer](drafts-and-contract-layer.md) – Arbeit zwischenspeichern und Specs für die Pipeline anreichern.
