# Modelle pro Agent anpassen

Das Nützlichste, was Profile dir ermöglichen, ist, **für jeden Schritt das richtige Modell zu wählen**. Ein Planungsschritt verdient vielleicht dein stärkstes Modell; ein routinemäßiger Build-Schritt ist mit etwas Schnellerem und Günstigerem womöglich vollkommen zufrieden. Profile lassen dich genau das ausdrücken.

Hier zahlt sich die Trennung von Geteiltem und Projektbezogenem aus:

- Die Agent-*Definitionen* bleiben in deinem Team geteilt.
- Das *Modell, mit dem jeder Agent läuft*, wird **pro Projekt** innerhalb eines Profils konfiguriert und wirkt sich nur auf dein Projekt aus.

Änderst du ein Modell, änderst du Kosten und Verhalten für dieses Projekt – ohne das Setup von irgendwem sonst oder die zugrunde liegenden Anweisungen des Agents anzufassen.

## Das Modell eines Agents ändern

Wähle unter **Agents → Profile** ein Profil aus und öffne seinen Agent-Ketten-Editor. Jeder Agent in der Kette hat ein Modellfeld. Zusätzlich gibt es ein **Orchestrator**-Modell, das die übergeordnete Koordination der Pipeline übernimmt.

Die Modellwerte sind Aliasse – für Claude sind das `opus`, `sonnet` und `haiku` (am leistungsfähigsten → am schnellsten). Setze pro Agent den gewünschten Alias:

- Lass das Modell eines Agents **leer**, um auf den Standard der Agent-Datei zurückzufallen.
- Setze es ausdrücklich, um es nur für dieses Profil zu überschreiben.

Speichere, und die nächste mit diesem Profil gestartete Rail nutzt die neuen Modelle. Bereits laufende Jobs behalten ihren Snapshot.

## Profile wie `fast` und `max` erstellen

Das naheliegende Muster sind ein paar benannte Profile, zu denen du je nach Aufgabe greifst:

**Ein `fast`-Profil** – für kleine, risikoarme Änderungen, bei denen du Tempo und eine kleinere Rechnung willst:

- Architect: ein mittleres oder schnelles Modell – der Plan ist einfach.
- Developer: ein schnelles Modell – die Änderung ist mechanisch.
- Reviewer: halte ihn solide, aber du kannst auch hier abspecken.

**Ein `max`-Profil** – für knifflige Features mit hohem Einsatz, bei denen jeder Schritt so scharf wie möglich sein soll:

- Architect, Developer und Reviewer: durchweg dein stärkstes Modell.

### Zwei Wege, eines zu bauen

1. **Duplizieren und anpassen** *(empfohlen).* Wähle dein `default`-Profil, **dupliziere** es, gib der Kopie einen kebab-case-Namen wie `fast` oder `max` und passe dann das Modell jedes Agents an. Du erbst eine bewährte Kette samt Routing und änderst nur, was du auch ändern willst.
2. **Leer starten.** Erstelle ein **leeres Profil** und stelle die Kette selbst zusammen. Du musst trotzdem das Basis-Trio (`sr-architect`, `sr-developer`, `sr-reviewer`) einbinden – die Pipeline hängt von allen dreien ab – sowie genau eine abschließende Auffang-Routing-Regel, die als Letztes stehen muss.

Profilnamen sind in Kleinbuchstaben im kebab-case (z. B. `fast`, `max`, `cheap-and-cheerful`).

## Aufgaben an bestimmte Agents routen

Die **Routing-Regeln** eines Profils entscheiden, welcher Agent eine getaggte Aufgabe übernimmt. Jede Regel listet Aufgaben-Tags und einen Ziel-Agent auf; die erste Regel, deren Tags passen, gewinnt, und eine einzige `default: true`-Regel am Ende fängt alles Übrige ab. Nur Agents, die tatsächlich in der Kette des Profils stehen, können Routing-Ziele sein – der Editor setzt das durch.

Für den Alltag fasst du das Routing nicht an: Die Auffangregel schickt Arbeit an den Developer, und das ist richtig. Greife zu Tag-Regeln, wenn du etwa möchtest, dass mit `migration` getaggte Arbeit an einen Spezialisten geht.

## Das Profil beim Start wählen

All das kommt beim Start zusammen: Wähle im Rail-Header pro Rail `fast`, `max` oder `default`. Ein Batch kann sie mischen – ein winziger Fix auf `fast`, ein großes Feature auf `max`, beide gleichzeitig laufend. Den Ablauf der Auswahl findest du unter [Profile & der ausgewogene Standard](profiles-and-the-balanced-default).

## Eine Anmerkung zur Sicherheit

Das Löschen eines Profils ist für laufende Arbeit unbedenklich: Bereits damit gestartete Jobs behalten ihren Snapshot, und künftige Starts fallen einfach durch die Auflösungsreihenfolge zurück. Experimentiere ruhig.

## Wie es weitergeht

- [Custom-Agents & der Katalog](custom-agents-catalog) – Agents hinzufügen, die du in deine Ketten einbinden kannst.
