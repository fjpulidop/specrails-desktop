# Specrails von jeder KI aus steuern (MCP-Server)

Specrails kann **sich selbst** für jeden KI-Assistenten bereitstellen, der das [Model Context Protocol](https://modelcontextprotocol.io) spricht — Claude Desktop, Claude Code, Cursor, Cline oder deinen eigenen Agenten. Schalte es ein, richte deinen Assistenten auf Specrails aus, und schon kannst du die ganze App per Chat steuern: *„Liste meine Projekte auf", „Erstelle eine Spec für Social-Login im API-Projekt", „Starte Rail 0 und sag mir, wenn es fertig ist", „Wie viel habe ich diese Woche ausgegeben?"*. Dein Assistent ruft im Hintergrund die Tools von Specrails auf, statt dass du dich durchklickst.

Das ist die umgekehrte Richtung zu den Plugins und dem Feature „Meine freigegebenen MCPs": Diese lassen Specrails andere MCP-Server *nutzen*; dieses hier lässt andere Apps **Specrails** nutzen.

## Einschalten

Es ist **standardmäßig aus**. Öffne **Einstellungen ▸ MCP** und aktiviere **MCP aktivieren**. Das war's — der Server startet sofort, ohne Neustart.

Du behältst die Kontrolle darüber, *was* eine externe KI über Specrails tun darf, und zwar über eine Reihe von Berechtigungsstufen:

| Stufe | Was sie erlaubt | Standard |
|---|---|---|
| **Lesen** | Projekte, Specs, Jobs, Analytics … auflisten und einsehen | Immer an (wenn MCP aktiviert ist) |
| **Schreiben** | Specs erstellen und bearbeiten, Einstellungen und Rail-Konfiguration ändern | Aus — opt-in |
| **KI-Start** | Aktionen, die eine KI ausführen und **Geld kosten** (ein Rail starten, eine Spec generieren, einen Chat-Zug senden) | Aus — opt-in |
| **Destruktiv** | Projekte/Specs/Jobs löschen, laufende Arbeit stoppen | Aus — opt-in |

Versucht dein Assistent etwas, das eine deaktivierte Stufe abdeckt, verweigert Specrails mit einer klaren Meldung, die dir sagt, welche Stufe du einschalten musst. So kannst du nur-lesend starten und genau das freigeben, was du brauchst.

## Deinen Assistenten verbinden

Das Panel zeigt einen fertigen Konfigurationsblock zum Einfügen. Der einfachste, universelle Weg ist die mitgelieferte **Bridge** (`specrails-mcp`): Dein Assistent führt sie aus, und sie leitet für dich an Specrails weiter. Die Bridge liest den Zugriffstoken lokal aus, sodass **der Token nie in der Konfiguration deines Assistenten auftaucht**.

In einem Client wie Claude Desktop oder Cursor sieht die Konfiguration so aus:

```json
{ "mcpServers": { "specrails": { "command": "specrails-mcp" } } }
```

Clients, die entfernte HTTP-MCP-Server unterstützen, können stattdessen direkt auf `http://127.0.0.1:4200/api/mcp` mit dem Token aus dem Panel zeigen.

### Vom Terminal aus: Claude Code, Gemini CLI, Codex CLI

Kopiere dein Token unter **Einstellungen ▸ MCP ▸ Token kopieren**, dann:

```bash
# Claude Code
claude mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <dein Token>"

# Gemini CLI
gemini mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <dein Token>"

# Codex CLI (stdio — registriere den Bridge-Befehl aus Einstellungen ▸ MCP)
codex mcp add specrails -- <Bridge-Befehl aus Einstellungen ▸ MCP>
```

Der Header `Authorization: Bearer <token>` funktioniert ebenfalls. Falls du den App-Port geändert hast, ersetze `4200`.

Einmal verbunden, sieht dein Assistent etwa **18 Tools**, die die ganze App abdecken — Projekte, Specs, Rails und Jobs, Chat/Explore, Agenten, Plugins, Jira, Loops, den Code-Explorer, Analytics, Einstellungen — plus ein eingebautes **Guide**-Tool, das er zuerst liest, sodass er versteht, wie Specrails funktioniert, ohne dass du irgendetwas erklären musst.

## Was du damit machen kannst

Ein paar Rezepte, sobald dein Assistent verbunden ist. Beginne mit aktiviertem **Lesen** und schalte dann **Schreiben** und **KI-Start** hinzu, wenn er tatsächlich Arbeit erstellen und starten soll.

**Mach aus Arbeit in deinen anderen Tools Specs.** Wenn dein Assistent auch GitHub, Jira, Gmail oder Slack verbunden hat, kann er die Arbeit für dich nach Specrails holen:
> *„Nimm die diese Woche offenen GitHub-Issues mit dem Label ‚bug', erstelle für jedes eine Spec im API-Projekt und starte sie."*
>
> *„Lies meine neuesten Kundenfeedback-E-Mails, gruppiere sie nach Thema und erstelle pro Thema eine Spec."*

**Autopilot über Nacht.** Lass es mit der App im Tray laufen und komm zu einem Bericht zurück:
> *„Hier sind 12 Ideen. Mach aus jeder eine Spec, starte sie zu dritt über die Rails, beobachte jeden Job und gib mir morgen eine Zusammenfassung, was fertig wurde, was fehlschlug und was es gekostet hat."*

Lass **Destruktiv** aus, und es kann die ganze Nacht bauen, ohne jemals etwas zu löschen.

**Über alle deine Projekte hinweg.** Etwas, das das Dashboard von allein nicht kann:
> *„Prüfe alle meine Projekte. Sag mir, welche Specs im Backlog haben und kein laufendes Rail, und starte in jedem das mit der höchsten Priorität."*

**Freihändig, während du programmierst.** Steuere Specrails aus deinem Editor oder per Sprache, ohne das Fenster zu wechseln:
> *„Starte Rail 0 im Freestyle-Modus mit Opus für Ticket #42 und sag mir, wenn es fertig ist."*

**Frag nach Kosten und Verlauf.** Deine Analytics, in einfacher Sprache:
> *„Wofür habe ich diese Woche am meisten für KI ausgegeben, nach Projekt und nach Modell? Zeig mir die fünf teuersten Tickets."*

**Dein tägliches Standup.**
> *„Schreib mein Standup: welche Rails gestern liefen, was abgeschlossen wurde, was fehlschlug, Gesamtkosten — als Stichpunkte, fertig zum Einfügen in Slack."*

**Den Code verstehen.** Kein Editor nötig:
> *„Welche Dateien hat Ticket #38 berührt? Fasse in einer Zeile zusammen, was sich in jeder geändert hat."*

Da dein Assistent zuerst das eingebaute Guide liest, musst du selten Tools oder Specs benennen — beschreibe das Ergebnis, und er findet die passenden Aufrufe heraus.

## Ein paar Dinge, die du wissen solltest

- **Specrails muss laufen.** Der MCP-Server lebt innerhalb der App, sodass dein Assistent ihn nur erreichen kann, solange Specrails geöffnet ist. Dank des Tray-Symbols hält das Schließen des Fensters die App im Hintergrund am Laufen — nur **Beenden** über das Tray (Mac-Menüleiste / Windows-Infobereich) stoppt sie wirklich.
- **Lange Aktionen streamen.** Ein Rail zu starten oder eine Spec zu generieren, kehrt sofort zurück und läuft im Hintergrund zu Ende; dein Assistent kann es „beobachten" und sich zurückmelden, sobald es abgeschlossen ist.
- **Sicherheit.** MCP verwendet seinen eigenen Zugriffstoken, getrennt von allem anderen, und lauscht nur auf deinem eigenen Rechner (Loopback). Du kannst diesen Token jederzeit aus dem Panel kopieren oder neu generieren.
- **Nicht freigegeben (v1).** Aus Sicherheitsgründen sind einige risikoreiche Funktionen bewusst ausgenommen: das Ausführen von Shell-Befehlen im Terminal, der eingebettete Browser, das In-App-Bearbeiten von Dateien und das Installieren von System-Voraussetzungen. Alles, was Specrails *verwaltet*, ist verfügbar; roher Zugriff auf den Rechner ist es nicht.

Du kannst MCP jederzeit über dasselbe Panel deaktivieren — dein Assistent verliert dann einfach den Zugriff, und sonst ändert sich nichts.
