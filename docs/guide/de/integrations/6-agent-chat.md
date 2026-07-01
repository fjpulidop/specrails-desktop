# Specrails per Chat steuern (Agent Chat)

Der **Agent Chat** ist ein Copilot, der *innerhalb* von Specrails lebt und die gesamte App für dich steuern kann. Statt dich durch Projekte, Specs, Rails und Analytics zu klicken, fragst du einfach: *„Wie viele Jobs waren diese Woche erfolgreich?“*, *„Erstelle eine Spec für Social Login im API-Projekt“*, *„Starte die drei Tickets mit der höchsten Priorität und sag mir Bescheid, wenn sie fertig sind“*. Er erledigt die Arbeit, indem er Specrails' eigene Werkzeuge aufruft — dieselben, die der [MCP-Server](./5-mcp-server.md) bereitstellt — während du das Dashboard dahinter live aktualisieren siehst.

> **Nicht mit den Pipeline-Agenten zu verwechseln.** Der Abschnitt *Agenten* (Architect → Developer → Reviewer) geht darum, *wie ein Rail eine Spec umsetzt*. Der **Agent Chat** ist ein einzelner Assistent, der *die App selbst bedient*. Zwei verschiedene Dinge, dasselbe Wort.

## So öffnest du ihn

Am unteren Rand des Fensters schwebt eine **Blase** — klicke sie an, um das Panel zu öffnen, oder drücke von überall aus **⌘⇧A** (**Ctrl+Shift+A** unter Windows/Linux). Das Panel ist ein echtes Fenster, das du verschieben, in der Größe ändern, maximieren und wieder in die Blase ablegen kannst; es merkt sich, wo du es zuletzt hattest.

Es ist **bewusst nicht-modal**: Das Dashboard dahinter bleibt lebendig, sodass du in Echtzeit siehst, wenn der Agent ein Rail startet oder eine Spec erstellt — du blickst nicht auf einen eingefrorenen Bildschirm.

## Voraussetzung: der MCP-Server

Der Agent Chat steuert die App über den eingebetteten **Specrails-MCP-Server**, der also aktiv sein muss. Ist er es nicht, öffnet sich das Panel mit einem Ein-Klick-Banner **Specrails MCP aktivieren** — drück drauf und du bist startklar (ohne Neustart). Details findest du unter [Specrails von jeder KI aus steuern](./5-mcp-server.md); es wird nichts installiert, alles läuft lokal auf deinem Rechner.

## Auswählen, woran er arbeitet

Die Kopfzeile hat einen **Projekt-Selektor** (wie bei Cursor). Wähle ein Projekt aus, und alles, was du fragst, bezieht sich darauf — *„Starte die mit hoher Priorität“* wird gegen dieses Projekt aufgelöst. Belässt du ihn auf **Start**, arbeitet der Agent über dein gesamtes Setup hinweg: Er kann Projekte auflisten oder anlegen und Fragen beantworten, die alles umfassen. Fragst du auf Start etwas Projektspezifisches, fragt er dich nach dem Projekt (oder bietet an, eins anzulegen), statt zu raten.

Ein Projekt hier auszuwählen **verschiebt** dein Dashboard **nicht** — das Ziel des Agenten und das, was du gerade ansiehst, sind unabhängig voneinander.

## Anbieter und Modell

Direkt über dem Nachrichtenfeld wählst du den **Anbieter** (Claude, Codex oder Gemini) und dessen **Modell**. Jeder Anbieter hat seine eigene Modellliste, und ein Anbieterwechsel startet eine frische Sitzung mit dem Standardmodell dieses Anbieters — so kannst du etwa die App mit Claude steuern und für eine andere Unterhaltung zu Codex wechseln, ohne dass etwas durcheinandergerät.

## Berechtigungsstufen — du hältst die Leine

Der Agent kann die ganze App anfassen, also entscheidest du, wie viel Freiheit er hat — über eine **Stufe**, die du live mit **Shift+Tab** änderst (derselbe Zyklus wie in Claude Code). Jede Stufe schließt alles darunter mit ein:

| Stufe | Was er tun kann |
|---|---|
| 👀 **Beobachten** | Nur lesen — Projekte, Specs, Jobs, Analytics auflisten und einsehen. Nichts ändert sich. |
| ✍️ **Bearbeiten** | Das Obige **+** erstellen und bearbeiten (Specs, Einstellungen, Rail-Konfiguration) — umkehrbare Änderungen. |
| ⚡ **Ausführen** | Das Obige **+** KI-Arbeit starten, die **Geld kostet** (Rails, Spec-Generierung). |
| 🔥 **Autonom** | Das Obige **+** Dinge löschen und stoppen — unumkehrbare Aktionen. |

Beginne bei **Beobachten** und erhöhe die Stufe erst, wenn der Agent handeln soll. Versucht er etwas oberhalb der aktuellen Stufe, hält er an und sagt dir genau, welche Stufe du einschalten musst — er umgeht die Grenze nie. Das ist getrennt von den Einstellungen ▸ MCP-Stufen, die *externe* Assistenten regeln; die Stufe hier gilt nur für diesen app-internen Agenten.

## Ein paar Dinge, die du fragen kannst

Sobald du auf **Ausführen** bist, probier:

> *„Liste jede To-do-Spec im API-Projekt auf, starte dann die drei mit der höchsten Priorität auf separaten Rails und behalte sie im Auge.“*
>
> *„Wie viel habe ich diese Woche ausgegeben, aufgeschlüsselt nach Projekt?“*
>
> *„Erstelle eine Spec für einen Dark-Mode-Umschalter im Web-Projekt, mit Contract Layer.“*
>
> *„Im letzten Batch ist etwas schiefgegangen — finde die fehlgeschlagenen Jobs und fasse zusammen, warum.“*

Antworten strömen flüssig herein und landen bereits formatiert (Überschriften, Tabellen, Listen), jede mit einem kleinen **Kopieren**-Button. Ein Status-Chip unten zeigt, was der Agent gerade tut — *Denkt nach…*, *MCP · jobs*, *Terminal* — sodass du seinen Zustand immer kennst.

## Praktische Feinheiten

- **Prompt-Verlauf.** Ist das Feld leer, drücke **↑**/**↓**, um durch deine früheren Fragen zu blättern (beim Scrollen abgedunkelt dargestellt); tippe los, um sie zu bearbeiten, oder drücke Enter zum Senden.
- **Minimieren, nicht verlieren.** Klicke auf das ✕, um das Panel zurück in die Blase abzulegen — die Unterhaltung läuft weiter. Öffne es wieder und du landest bei der neuesten Nachricht; nichts muss neu getippt werden.
- **Neue Unterhaltung.** Der **+**-Button startet einen sauberen Thread; der Verlauf lebt app-weit, oberhalb jedes einzelnen Projekts.

## Ein paar Dinge, die du wissen solltest

- **Ausführen und Autonom kosten Geld**, weil sie KI laufen lassen. Der Agent hebt kostenverursachende Aktionen hervor, bevor er sie ausführt; belasse die Stufe bei Beobachten oder Bearbeiten, wenn du nur schauen und aufräumen willst.
- **Der Agent gilt app-weit**, nicht an das gerade geöffnete Projekt gebunden — deshalb hat er seinen eigenen Selektor, und sein Verlauf ist nicht pro Projekt.
- **Er ist nur so fähig, wie es der MCP zulässt.** Wenn ein ganzer Bereich gesperrt scheint, prüfe, ob der MCP-Server aktiviert ist.
