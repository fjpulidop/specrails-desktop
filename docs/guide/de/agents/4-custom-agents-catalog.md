# Custom-Agents & der Katalog

Profile entscheiden, *welche Agents mit welchen Modellen laufen*. Doch woher kommen die Agents selbst? Aus dem **Agents-Katalog**.

Öffne in einem beliebigen Projekt **Agents → Katalog**. Es ist eine schreibgeschützte Ansicht jedes Agents, der diesem Projekt zur Verfügung steht, in zwei Gruppen:

- **Upstream-Agents** – die Rollen, die die Core-Engine zur Laufzeit definiert: das Basis-Trio (`sr-architect`, `sr-developer`, `sr-reviewer`). Sie sind keine Dateien in deinem Repo; der Katalog zeigt die live geltende Definition jeder Rolle schreibgeschützt an, bearbeiten kannst du sie unter **Einstellungen → Agenten-Laufzeit**.
- **Custom-Agents** – Agents, die du selbst hinzugefügt hast, benannt als `custom-*`.

Jeder Katalogeintrag zeigt, wofür der Agent da ist; Custom-Agents zeigen zusätzlich ihr Standardmodell, während die Basis-Rollen mit Provider und Modell aus **Einstellungen → Agenten-Laufzeit** laufen. So siehst du in jedem Fall die vollständige Aufstellung, bevor du Agents in eine Profil-Kette einbindest.

## Einen Custom-Agent hinzufügen

Weil sie in deinem Repo leben, sind Custom-Agents **committfähige Team-Assets**: Committe die Datei, und dein ganzes Team bekommt den Agent. Das spiegelt die Kernidee, die sich durch den gesamten Agents-Bereich zieht –

> **Custom-Agent-Definitionen sind geteilt (sie leben im Repo und reisen mit `git` mit); die Basis-Rollen definiert die Core-Laufzeit. Die Modellkonfiguration ist projektbezogen (sie lebt in Profilen).**

## Einen Custom-Agent einsetzen

Der typische Ablauf:

## Beobachten, wie sich Profile schlagen

Der Agents-Bereich hat außerdem einen **Nutzung**-Tab – eine Aufschlüsselung pro Profil, wie viele Jobs in einem gewählten Zeitraum unter jedem Profil liefen. Das ist eine schnelle Möglichkeit zu prüfen, ob deine Aufteilung in `fast`/`max` tatsächlich so genutzt wird, wie du es beabsichtigt hast, und zu erkennen, zu welchem Profil dein Team tendiert.

## Zusammenfassung des gesamten Bereichs

- **Agents** sind die spezialisierten Teammitglieder – das geteilte Trio plus Spezialisten und deine Custom-Agents. ([Die Agents im Überblick](meet-the-agents))
- **Profile** bündeln, welche Agents mit welchen Modellen laufen und wie Aufgaben geroutet werden – pro Rail beim Start ausgewählt. Das default-Profil ist die ausgewogene Alltagswahl. ([Profile & der ausgewogene Standard](profiles-and-the-balanced-default))
- **Modelle** werden pro Agent, pro Projekt, innerhalb von Profilen feinjustiert – baue `fast` und `max`, passend zur Aufgabe. ([Modelle pro Agent anpassen](customizing-models-per-agent))
- **Der Katalog** zeigt jeden Agent, und der `custom-*`-Namespace lässt dich das Team erweitern – Definitionen geteilt, Konfiguration projektbezogen.
