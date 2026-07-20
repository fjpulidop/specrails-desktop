# Engine pro Rail wählen

Specrails desktop behandelt **Claude Code**, **Codex CLI**, **Gemini CLI** und
**Kimi Code** als gleichwertige Engines. Jede kompatible Kombination ist möglich.

## Wann die Auswahl erscheint

Die **Engine-Auswahl** sitzt im Rail-Header, direkt neben der Modus-Auswahl. Sie wird nur angezeigt, wenn das Projekt **mehr als einen** Provider installiert hat.

> **Projekte mit nur einem Provider verhalten sich byteidentisch.** Hat ein Projekt nur eine Engine, erscheint keine Auswahl, und an der Provider-Wahl ändert sich nichts — es läuft einfach auf dieser Engine. Die Auswahl ist ausschließlich für Multi-Provider-Projekte da.

Wenn sie erscheint, gilt deine Wahl **pro Rail und pro Start** — verschiedene Rails können verschiedene Engines ausführen, und deine Wahl wird pro Projekt gemerkt (mit der primären Engine des Projekts als Voreinstellung).

## So wählst du eine Engine

1. Vergewissere dich, dass die Engine-Auswahl der Rail sichtbar ist (Projekt hat 2+ Provider).
2. Klick darauf und wähle **Claude**, **Codex**, **Gemini** oder **Kimi**.
3. Starte die Rail mit **▶ Play**.

Die ausgewählte Engine führt jede Phase der Pipeline dieser Rail aus. Ist die CLI der gewählten Engine nicht installiert, schlägt der Start sofort fehl — es wird nichts gestartet. Installiere die fehlende CLI und versuch es erneut.

## Wofür jede Engine gut ist

Alle vier führen **Implement** und **Batch** aus:

| Engine | Greif dazu, wenn… | Hinweise |
|--------|--------------------|-------|
| **Claude** | Du native Kosten, persistente Interaktion oder strikte Tool-Policies brauchst. | Profile, Freestyle und strukturierte Transforms. |
| **Codex** | Du die OpenAI Codex CLI bevorzugst oder Implementierungen über verschiedene Provider hinweg vergleichen willst. | `codex` ≥ 0.128.0. Keine native Kostenmeldung — die App ergänzt die Kosten aus ihrer Preistabelle. Profile gelten nicht. |
| **Gemini** | Du Googles Gemini CLI, native Telemetrie oder einen günstigeren Lauf für Routine-Specs willst. | `gemini` ≥ 0.11.0 (setze `GEMINI_API_KEY`). Native OTLP-Telemetrie. Profile gelten nicht. |
| **Kimi** | Du agentisches Kimi für Implement, Batch, Freestyle oder Loops ohne Decider willst. | Externes `kimi` ≥ 0.27.0; Profile/Rollen, Effort nur K3; Tokens/Kosten nicht verfügbar. |

### Fähigkeitsunterschiede

Claude und Kimi unterstützen Profile/Freestyle; Codex/Gemini laufen legacy.
Kimi lehnt Loop Decider und die Pure-Output-Transforms im
[Kimi-Guide](../../../kimi.md) ab. Claude/Kimi-Profile sind getrennt.

## Ein praktischer Workflow

Multi-Provider-Projekte spielen ihre Stärken aus, wenn du **vergleichen** oder **kostenoptimieren** willst:

- **Implementierungen vergleichen.** Leg dieselbe Spec auf zwei Rails, stell eine auf Claude und eine auf Codex, starte beide (über Projekte hinweg oder nacheinander in der Queue desselben Projekts) und nutze dann den **Compare**-Button auf der Jobs-Seite, um die Ergebnisse zu vergleichen.
- **Pro Spec kostenoptimieren.** Lass wichtige Specs auf Claude mit einem `max`-Profil laufen; lass Routine-Aufräum-Specs auf Gemini laufen, um Ausgaben zu sparen. Filtere `/analytics` nach Engine, um die Aufschlüsselung zu sehen.
- **Sinnvoll voreinstellen.** Lege deine meistgenutzte Engine als primäre Engine des Projekts fest, damit Rails standardmäßig darauf laufen, und wechsle nur pro Rail, wenn eine bestimmte Spec eine andere will.

## Worauf du achten solltest

- **Die Provider-Wahl ist nach dem Anlegen des Projekts unveränderlich** (v1). Du wählst die installierten Provider beim Hinzufügen des Projekts; es gibt keinen Einstellungs-Schalter, um später einen hinzuzufügen oder zu entfernen.
- **Verfügbare Metriken werden erfasst.** Kimi liefert keine autoritativen
  Tokens/USD-Kosten; die Felder bleiben leer.
- **Der „Open AI CLI“-Button im Terminal** bietet bei Multi-Provider-Projekten ebenfalls eine Provider-Auswahl, falls du eine CLI lieber von Hand bedienst.

## Wie es weitergeht

- [Codex verwenden](../integrations/using-codex) — installieren und anmelden.
- [Gemini verwenden](../integrations/using-gemini) — installieren, `GEMINI_API_KEY`, Telemetrie.
- [Kimi verwenden](../../../kimi.md) — Installation und vollständige Matrix.
- [Rails & Jobs](rails-and-jobs) — die Queue und der Start-Flow.
- [Kosten verfolgen](../analytics/tracking-cost) — Kostenaufschlüsselung pro Engine.
