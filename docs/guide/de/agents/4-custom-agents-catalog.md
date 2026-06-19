# Custom-Agents & der Katalog

Profile entscheiden, *welche Agents mit welchen Modellen laufen*. Doch woher kommen die Agents selbst? Aus dem **Agents-Katalog**.

Öffne in einem beliebigen Projekt **Agents → Katalog**. Es ist eine schreibgeschützte Ansicht jedes Agents, der diesem Projekt zur Verfügung steht, in zwei Gruppen:

- **Upstream-Agents** – die Agents, die mit `specrails-core` ausgeliefert werden: das Basis-Trio (`sr-architect`, `sr-developer`, `sr-reviewer`) und etwaige Spezialisten wie `sr-merge-resolver`.
- **Custom-Agents** – Agents, die du selbst hinzugefügt hast, benannt als `custom-*`.

Jeder Katalogeintrag zeigt, wofür der Agent da ist und welches Standardmodell er nutzt, sodass du die vollständige Aufstellung sehen kannst, bevor du Agents in eine Profil-Kette einbindest.

## Einen Custom-Agent hinzufügen

Custom-Agents sind schlichte Markdown-Dateien in deinem Repository unter `.claude/agents/`, benannt als `custom-<etwas>.md`. Die Datei enthält die Anweisungen des Agents (seinen System-Prompt) und einen kleinen Frontmatter-Header mit einem Standard-`model:`.

Sobald die Datei im Projekt existiert, erscheint sie im Katalog als Custom-Agent, und du kannst ihre id zur Agent-Kette jedes Profils hinzufügen (und Aufgaben an sie routen). Die id muss zum Dateinamen passen – ein Eintrag für `custom-docs` verweist auf `.claude/agents/custom-docs.md`.

Weil sie in deinem Repo leben, sind Custom-Agents **committfähige Team-Assets**: Committe die Datei, und dein ganzes Team bekommt den Agent. Das spiegelt die Kernidee, die sich durch den gesamten Agents-Bereich zieht –

> **Agent-Definitionen sind geteilt (sie leben im Repo und reisen mit `git` mit). Die Modellkonfiguration ist projektbezogen (sie lebt in Profilen).**

Der `custom-*`-Namespace ist reserviert und geschützt: Die Befehle `init` und `update` von `specrails-core` fassen `.claude/agents/custom-*.md` nie an, sodass deine Custom-Agents Core-Upgrades unangetastet überstehen. (Derselbe Schutz gilt für von Plugins beigesteuerte Fragmente wie `custom-serena.md`.)

## Einen Custom-Agent einsetzen

Der typische Ablauf:

1. Schreibe `.claude/agents/custom-<name>.md` mit Anweisungen und einem Standardmodell.
2. Stelle sicher, dass er unter **Agents → Katalog** im Bereich Custom auftaucht.
3. Füge den Agent unter **Agents → Profile** zur Kette eines Profils hinzu (und überschreibe optional sein Modell für dieses Profil).
4. Ergänze eine Routing-Regel, damit Aufgaben mit den passenden Tags ihn erreichen – oder verlasse dich auf die Reihenfolge der Kette.
5. Starte eine Rail mit diesem Profil aus dem Rail-Header.

## Beobachten, wie sich Profile schlagen

Der Agents-Bereich hat außerdem einen **Nutzung**-Tab – eine Aufschlüsselung pro Profil, wie viele Jobs in einem gewählten Zeitraum unter jedem Profil liefen. Das ist eine schnelle Möglichkeit zu prüfen, ob deine Aufteilung in `fast`/`max` tatsächlich so genutzt wird, wie du es beabsichtigt hast, und zu erkennen, zu welchem Profil dein Team tendiert.

## Zusammenfassung des gesamten Bereichs

- **Agents** sind die spezialisierten Teammitglieder – das geteilte Trio plus Spezialisten und deine Custom-Agents. ([Die Agents im Überblick](meet-the-agents))
- **Profile** bündeln, welche Agents mit welchen Modellen laufen und wie Aufgaben geroutet werden – pro Rail beim Start ausgewählt. Das default-Profil ist die ausgewogene Alltagswahl. ([Profile & der ausgewogene Standard](profiles-and-the-balanced-default))
- **Modelle** werden pro Agent, pro Projekt, innerhalb von Profilen feinjustiert – baue `fast` und `max`, passend zur Aufgabe. ([Modelle pro Agent anpassen](customizing-models-per-agent))
- **Der Katalog** zeigt jeden Agent, und der `custom-*`-Namespace lässt dich das Team erweitern – Definitionen geteilt, Konfiguration projektbezogen.
