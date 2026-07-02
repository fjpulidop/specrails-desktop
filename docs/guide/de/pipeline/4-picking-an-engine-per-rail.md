# Engine pro Rail wählen

Specrails desktop behandelt **Claude Code**, **Codex CLI** und **Gemini CLI** als gleichwertige Engines. Ein Projekt kann eine, zwei oder alle drei installiert haben — und wenn mehr als eine vorhanden ist, wählst du, welche Engine jede Rail ausführt. Diese Seite zeigt die Engine-Auswahl pro Rail und wann du zu welcher greifst.

## Wann die Auswahl erscheint

Die **Engine-Auswahl** sitzt im Rail-Header, direkt neben der Modus-Auswahl. Sie wird nur angezeigt, wenn das Projekt **mehr als einen** Provider installiert hat.

> **Projekte mit nur einem Provider verhalten sich byteidentisch.** Hat ein Projekt nur eine Engine, erscheint keine Auswahl, und an der Provider-Wahl ändert sich nichts — es läuft einfach auf dieser Engine. Die Auswahl ist ausschließlich für Multi-Provider-Projekte da.

Wenn sie erscheint, gilt deine Wahl **pro Rail und pro Start** — verschiedene Rails können verschiedene Engines ausführen, und deine Wahl wird pro Projekt gemerkt (mit der primären Engine des Projekts als Voreinstellung).

## So wählst du eine Engine

1. Vergewissere dich, dass die Engine-Auswahl der Rail sichtbar ist (Projekt hat 2+ Provider).
2. Klick darauf und wähle **Claude**, **Codex** oder **Gemini**.
3. Starte die Rail mit **▶ Play**.

Die ausgewählte Engine führt jede Phase der Pipeline dieser Rail aus. Ist die CLI der gewählten Engine nicht installiert, schlägt der Start sofort fehl — es wird nichts gestartet. Installiere die fehlende CLI und versuch es erneut.

## Wofür jede Engine gut ist

Alle drei führen die Standard-Pipelines **Implement** und **Batch** aus. Hier ein praktischer Leitfaden zur Auswahl:

| Engine | Greif dazu, wenn… | Hinweise |
|--------|--------------------|-------|
| **Claude** | Du den vollen Funktionsumfang willst: Agent-Profile, Freestyle, native Kostenmeldung, die umfangreichste Tool-Unterstützung. Der Standard für die meiste Arbeit. | Die einzige Engine, die **Agent-Profile**, **Freestyle** und ein paar Claude-exklusive Spec-Features (Contract Layer, SMASH) unterstützt. |
| **Codex** | Du die OpenAI Codex CLI bevorzugst oder Implementierungen über verschiedene Provider hinweg vergleichen willst. | `codex` ≥ 0.128.0. Keine native Kostenmeldung — die App ergänzt die Kosten aus ihrer Preistabelle. Profile gelten nicht. |
| **Gemini** | Du Googles Gemini CLI, native Telemetrie oder einen günstigeren Lauf für Routine-Specs willst. | `gemini` ≥ 0.11.0 (setze `GEMINI_API_KEY`). Native OTLP-Telemetrie. Profile gelten nicht. |

### Die Claude-exklusiven Features

Ein paar Dinge funktionieren nur auf Claude-Rails — wähle Claude, wenn du sie brauchst:

- **Agent-Profile** — Modell-Routing pro Agent. Auf Codex- oder Gemini-Rails läuft der Lauf immer im Legacy-Modus, und ein ausgewähltes Profil wird **ignoriert**. Die Profil-Auswahl ist für Nicht-Claude-Engines ausgeblendet.
- **Freestyle** — der autonome, pipeline-umgehende Modus. Das `Freestyle`-Segment und seine Haiku/Sonnet/Opus-Modell-Auswahl erscheinen nur, wenn die Engine der Rail Claude ist.
- **Contract Layer & SMASH** — Claude-exklusive Features zur Spec-Verfeinerung (das sind Add-Spec-Optionen, keine Rail-Optionen, aber dieselbe Einschränkung gilt).

Wenn ein Projekt Engines mischt, zeigt die rechte Seitenleiste nur Bereiche, die **jeder** installierte Provider unterstützt — der **Agents**-Bereich verschwindet also komplett bei einem Projekt, das irgendeinen Nicht-Claude-Provider enthält, weil Profile Claude-spezifisch sind.

## Ein praktischer Workflow

Multi-Provider-Projekte spielen ihre Stärken aus, wenn du **vergleichen** oder **kostenoptimieren** willst:

- **Implementierungen vergleichen.** Leg dieselbe Spec auf zwei Rails, stell eine auf Claude und eine auf Codex, starte beide (über Projekte hinweg oder nacheinander in der Queue desselben Projekts) und nutze dann den **Compare**-Button auf der Jobs-Seite, um die Ergebnisse zu vergleichen.
- **Pro Spec kostenoptimieren.** Lass wichtige Specs auf Claude mit einem `max`-Profil laufen; lass Routine-Aufräum-Specs auf Gemini laufen, um Ausgaben zu sparen. Filtere `/analytics` nach Engine, um die Aufschlüsselung zu sehen.
- **Sinnvoll voreinstellen.** Lege deine meistgenutzte Engine als primäre Engine des Projekts fest, damit Rails standardmäßig darauf laufen, und wechsle nur pro Rail, wenn eine bestimmte Spec eine andere will.

## Worauf du achten solltest

- **Die Provider-Wahl ist nach dem Anlegen des Projekts unveränderlich** (v1). Du wählst die installierten Provider beim Hinzufügen des Projekts; es gibt keinen Einstellungs-Schalter, um später einen hinzuzufügen oder zu entfernen.
- **Kosten werden immer verfolgt**, auch für Engines ohne native Kostenmeldung — die App greift auf eine Preistabelle zurück, sodass auch Codex- und Gemini-Läufe in den [Analysen](../analytics/tracking-cost) auftauchen.
- **Der „Open AI CLI“-Button im Terminal** bietet bei Multi-Provider-Projekten ebenfalls eine Provider-Auswahl, falls du eine CLI lieber von Hand bedienst.

## Wie es weitergeht

- [Codex verwenden](../integrations/using-codex) — installieren und anmelden.
- [Gemini verwenden](../integrations/using-gemini) — installieren, `GEMINI_API_KEY`, Telemetrie.
- [Rails & Jobs](rails-and-jobs) — die Queue und der Start-Flow.
- [Kosten verfolgen](../analytics/tracking-cost) — Kostenaufschlüsselung pro Engine.
