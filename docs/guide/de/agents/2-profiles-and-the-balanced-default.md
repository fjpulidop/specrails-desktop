# Profile & der ausgewogene Standard

Ein **Profil** ist ein gespeichertes Rezept für einen Pipeline-Durchlauf. Es beantwortet drei Fragen an einem Ort:

1. **Welche Agents** mitwirken (das Basis-Trio plus etwaige Spezialisten oder Custom-Agents).
2. **Mit welchem Modell** jeder Agent läuft.
3. **Wie Aufgaben** an diese Agents geroutet werden.

Du findest Profile im Bereich **Agents** jedes Projekts (rechte Seitenleiste → **Agents** → Tab **Profile**).

## Der ausgewogene Standard

Von Haus aus löst ein Projekt auf ein sinnvolles **default**-Profil auf. Es enthält das Basis-Trio – `sr-architect`, `sr-developer`, `sr-reviewer` – und routet über eine einzige Auffangregel jede Aufgabe an den Developer. Die Modelle sind für den Alltag ausgewogen: ein leistungsfähiges Modell dort, wo es zählt, ohne bei jedem Schritt zur teuersten Option zu greifen.

Falls dein Projekt die Agent-Modelle bereits auf die alte Weise konfiguriert hatte (in der Frontmatter der Agent-Dateien), liest der **Migrieren**-Button diese aus und baut ein `default`-Profil, das das heutige Verhalten exakt abbildet – verlustfrei, nichts ändert sich, bis du dich entscheidest, daran zu drehen.

Die Kernaussage: **Du musst kein Profil erstellen, um Specrails zu nutzen.** Der Standard funktioniert einfach. Profile sind der Weg, weiterzugehen.

## Wie ein Profil für einen Durchlauf gewählt wird

Wenn du eine Rail startest, wählt Specrails ein Profil in dieser Reihenfolge:

1. **Deine ausdrückliche Wahl** im Rail-Header (siehe unten).
2. Deine **persönliche Vorgabe** – ein Profil, das du als deinen persönlichen Standard für dieses Projekt markiert hast (sie ist lokal bei dir und wird nicht committet).
3. Das **`default`**-Profil des Projekts.

Das Profil wird *beim Start als Snapshot festgehalten*, sodass jede Rail in einem Batch ein anderes Profil ausführen kann und das spätere Ändern eines Profils nie bereits gestartete Jobs umschreibt.

## Ein Profil pro Rail auswählen

Die Profilwahl passiert genau dort, wo du startest – im **Rail-Header**, über den Profil-Selektor.

- Wähle ein Profil aus dem Dropdown, um es **nur für diesen Start** zu verwenden.
- Nutze die Option zum Festschreiben, um ein Profil künftig zur dauerhaften Wahl der Rail zu machen.

Das ist der ganze Ablauf: Profil wählen, starten, fertig. Gleichzeitig laufende Rails im selben Batch können jeweils ihr eigenes Profil tragen, sodass ein schneller Fix und ein umfangreiches Feature mit unterschiedlichen Setups nebeneinander laufen können.

## Wenn der Agents-Bereich still ist

Profile sind provider-spezifisch. Claude und Kimi unterstützen Profile/Rollen;
Codex und Gemini laufen im Legacy-Modus. Gleiche Namen können in gemischten
Projekten nicht zwischen Claude und Kimi übergreifen. Kimi erlaubt manuelle
Rollen, aber Agent-Studio-Generierung, Smoke-Test und AI Refine werden vor dem
Spawn abgelehnt. Kimi benötigt `specrails-core` 4.12.0 oder neuer.

## Wie es weitergeht

- [Modelle pro Agent anpassen](customizing-models-per-agent) – `fast`- und `max`-Profile bauen.
- [Custom-Agents & der Katalog](custom-agents-catalog) – das Team ansehen und erweitern.
