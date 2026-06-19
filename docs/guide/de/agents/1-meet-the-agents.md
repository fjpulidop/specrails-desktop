# Die Agents im Überblick

Wenn du eine **Implement**-Rail startest, übergibt Specrails deine Spec nicht einfach einer einzigen KI und hofft auf das Beste. Stattdessen arbeitet ein kleines Team spezialisierter *Agents*, jeder mit einer einzigen Aufgabe und in einer bewusst gewählten Reihenfolge. Diese Seite stellt dir vor, wer zu diesem Team gehört und was jeder Einzelne tut.

## Das Basis-Trio

Jeder Pipeline-Durchlauf nutzt diese drei Agents – sie bilden das Rückgrat, und ohne sie kann ein Projekt keine Rail starten.

| Agent | Rolle | Aufgabe |
|-------|------|--------------|
| **sr-architect** | Der Planer | Liest deine Spec, inspiziert die Codebasis und erstellt einen konkreten Umsetzungsplan – welche Dateien angefasst werden, welche Form die Änderung annimmt und worauf zu achten ist. Er denkt nach, bevor irgendjemand Code schreibt. |
| **sr-developer** | Der Umsetzer | Nimmt den Plan des Architekten und schreibt den Code tatsächlich: neue Dateien, Änderungen, Tests. Hier wird aus deiner Spec ein echtes Diff. |
| **sr-reviewer** | Der Kritiker | Prüft die Arbeit des Developers gegen Spec und Plan, findet Regressionen und meldet sich, wenn etwas nicht stimmt. Er ist das Qualitätstor, bevor die Änderung als fertig gilt. |

Stell es dir als **Design → Build → Review** vor – derselbe Ablauf, dem auch ein sorgfältiges menschliches Team folgen würde. Jeder Agent übergibt sein Ergebnis an den nächsten, sodass der Developer nie blind arbeitet und der Reviewer stets die ursprüngliche Absicht zum Abgleich hat.

## Spezialisten-Agents

Über das Trio hinaus kann ein Projekt optionale **Spezialisten-Agents** enthalten, die bestimmte Arten von Arbeit übernehmen. Der häufigste, der dir begegnet, ist:

- **sr-merge-resolver** – ein Hilfs-Agent, der dabei hilft, Merge-Konflikte zu entwirren und sich überschneidende Änderungen in Einklang zu bringen. Er ist optional: Profile binden ihn nur ein, wenn du es möchtest, und er blockiert die Pipeline nie, wenn er fehlt.

Spezialisten sind opt-in. Ein frisches Projekt läuft nur mit dem Trio; Spezialisten (und deine eigenen **Custom-Agents** – siehe [Custom-Agents & der Katalog](custom-agents-catalog)) fügst du hinzu, wenn der Workflow eines Projekts danach verlangt.

## Wie Aufgaben zum richtigen Agent gelangen

Innerhalb eines Durchlaufs wird Arbeit *geroutet*. Eine Aufgabe trägt Tags, und die Routing-Regeln eines Profils schicken getaggte Aufgaben an den am besten geeigneten Agent – mit einer abschließenden Auffangregel, die alles Übrige an den Developer leitet. Für den normalen Gebrauch musst du dir darüber keine Gedanken machen; das Standardsetup routet von Haus aus alles sinnvoll. Wenn du bereit bist, bestimmte Arten von Arbeit an bestimmte Agents zu lenken, schau dir [Modelle pro Agent anpassen](customizing-models-per-agent) an.

## Eine wichtige Idee vorab

Die *Definition* jedes Agents – seine Anweisungen, seine Persönlichkeit, was er darf – ist **geteilt**. Sie lebt als Datei (`.claude/agents/<id>.md`), die mit deinem Repository mitreist, sodass dein ganzes Team denselben Architekten und denselben Reviewer nutzt.

Was **pro Projekt** gilt, ist die *Konfiguration* darüber: mit welchem Modell jeder Agent läuft und welche Kombination von Agents du für eine bestimmte Rail wählst. Genau dafür sind Profile da – und das ist die nächste Seite.

## Wie es weitergeht

- [Profile & der ausgewogene Standard](profiles-and-the-balanced-default) – wie das Setup des Teams verpackt und ausgewählt wird.
- [Modelle pro Agent anpassen](customizing-models-per-agent) – Kosten und Qualität feinjustieren.
