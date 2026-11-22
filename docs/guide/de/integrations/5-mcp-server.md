# Specrails von jeder KI aus steuern (MCP-Server) {#mcp-server}

Specrails kann **sich selbst** für jeden KI-Assistenten bereitstellen, der das [Model Context Protocol](https://modelcontextprotocol.io) spricht — Claude Desktop, Claude Code, Cursor, Cline oder deinen eigenen Agenten. Schalte es ein, richte deinen Assistenten auf Specrails aus, und schon kannst du die ganze App per Chat steuern: *„Liste meine Projekte auf", „Erstelle eine Spec für Social-Login im API-Projekt", „Starte Rail 0 und sag mir, wenn es fertig ist", „Wie viel habe ich diese Woche ausgegeben?"*. Dein Assistent ruft im Hintergrund die Tools von Specrails auf, statt dass du dich durchklickst.

Das ist die umgekehrte Richtung zu den Plugins und dem Feature „Meine freigegebenen MCPs": Diese lassen Specrails andere MCP-Server *nutzen*; dieses hier lässt andere Apps **Specrails** nutzen.

## Von Anfang an eingeschaltet

Es ist **standardmäßig an** — der Server läuft bereits beim ersten Öffnen der App, ohne Neustart und ohne etwas umzulegen. Öffne **Einstellungen ▸ MCP**, um die Client-Konfiguration zu kopieren oder ihn auszuschalten, falls du ihn nicht willst.

Du behältst die Kontrolle darüber, *was* eine externe KI über Specrails tun darf, und zwar über eine Reihe von Berechtigungsstufen:

| Stufe | Was sie erlaubt | Standard |
|---|---|---|
| **Lesen** | Projekte, Specs, Jobs, Analytics … auflisten und einsehen | Immer an (wenn MCP aktiviert ist) |
| **Schreiben** | Specs erstellen und bearbeiten, Einstellungen und Rail-Konfiguration ändern | An — zum Einschränken abwählen |
| **KI-Start** | Aktionen, die eine KI ausführen und **Geld kosten** (ein Rail starten, eine Spec generieren, einen Chat-Zug senden) | An — zum Einschränken abwählen |
| **Destruktiv** | Projekte/Specs/Jobs löschen, laufende Arbeit stoppen | An — zum Einschränken abwählen |

Alle vier Stufen sind von Anfang an gewährt, sodass ein verbundener Assistent die ganze App sofort steuern kann. Wähle jede Stufe ab, die du lieber für dich behältst; versucht dein Assistent danach etwas, das diese Stufe abdeckt, verweigert Specrails mit einer klaren Meldung, welche Stufe du wieder einschalten musst.

## Claude Code oder Codex in einem Schritt verbinden

Öffne **Einstellungen ▸ MCP** und klicke neben Claude Code oder Codex auf **Verbinden** – oder führe einen Befehl im Terminal aus:

```bash
specrails-desktop mcp connect --client claude   # oder codex
```

Specrails trägt sich in die Konfiguration des Clients ein, sichert die Datei vorher, schreibt nirgends ein Zugriffstoken und prüft die Verbindung sofort (du siehst, wie viele Tools gefunden wurden). Mehrfaches Ausführen schadet nicht. Starte danach eine neue Claude-Code- oder Codex-Sitzung. **Befehl kopieren** zeigt den Befehl des Clients, falls du ihn selbst ausführen möchtest; für andere Assistenten nimm **Konfiguration kopieren**.

**Vor dem Ausgeben fragen** (im selben Bereich, standardmäßig 0,50 $) ist der Betrag, ab dem ein verbundener Assistent dich fragen muss, bevor er bezahlte Arbeit startet. Merges, PRs und Löschungen fragen immer. Dein Assistent bekommt einen einfachen Satz aus 15 Tools mit fertigen nächsten Schritten, Warten ohne Abfragen, Antworten in deiner Sprache und Prompts wie *start-my-day*, *review-waiting*, *ship-milestone* und *why-stuck*. Braucht ein älteres Skript die bisherigen Tools, schalte **Vereinfachte MCP-Tools** im selben Bereich aus; die Missionen von Specrails selbst sind davon nicht betroffen.

## Nur für Agenten: deinen Client verbinden

Wenn eine Person einen Agenten bittet, sich zu verbinden, lies das [MCP-Verbindungshandbuch](https://github.com/fjpulidop/specrails-desktop/blob/main/docs/agents/mcp.md). Es beschreibt das Verbinden mit einem Befehl, die manuelle Registrierung für Claude Code und Codex, die Prüfung und die Fehlersuche. Eine Registrierung allein beweist keine Verbindung: Schließe `initialize`, `tools/list` und einen reinen Lesezugriff ab.

Für einen schnellen Überblick über alles ruft der Assistent `specrails_overview` auf: was läuft, was auf dich wartet, letzte Fehlschläge, die heutigen Ausgaben sowie CPU und Arbeitsspeicher des Rechners, in einem Aufruf. `specrails_inbox` liest und beantwortet den Posteingang **Offen**, `specrails_missions` listet deine Missionen und schickt ihnen Nachrichten, `specrails_specs` und `specrails_rails` zeigen Backlog und Rails eines Projekts, `specrails_insights` deine Ausgaben und Limits, und `specrails_wait` wartet auf das Ende einer Ausführung, statt immer wieder nachzufragen. Eine fehlgeschlagene Ausführung kommt mit ihrer Diagnose und dem Ende ihres Logs.

Jede Antwort beginnt mit einer kurzen Zusammenfassung in einfacher Sprache und den möglichen nächsten Schritten, der empfohlene ist markiert, und Fehler sagen, was schiefging und ob ein neuer Versuch hilft. Vor allem Unumkehrbaren oder bezahlter Arbeit über deinem Limit zeigt dir der Assistent eine Vorschau und fragt zuerst. Dein Ja gilt nur für genau diese Aktion und verfällt, wenn sich zwischendurch etwas ändert.

Vor einer Aktion kann der Assistent mit `specrails_overview` einen aktuellen Überblick über ein Projekt holen: Specs, Ausführungen und Git-Stand. Nicht verfügbare Abschnitte werden ausdrücklich gemeldet; sie bedeuten nicht, dass das Projekt leer ist. Er kann außerdem deinen Quellcode durchsuchen und zeilenweise lesen, ohne ihn zu ändern.

Jede externe MCP-Sitzung hat ihre eigene Projektauswahl. Im Missionsmodus gilt standardmäßig das im Gespräch angeheftete Projekt, das du in der Missionsoberfläche änderst; eine MCP-Auswahl kann es nicht überschreiben. Wer in einem Aufruf ein anderes Projekt nennt, zielt bewusst auf dieses Projekt.

## Was du damit machen kannst

Ein paar Rezepte, sobald dein Assistent verbunden ist. Alles ist standardmäßig an; wähle **Schreiben** oder **KI-Start** in Einstellungen ▸ MCP ab, wenn er vorerst nur beobachten soll.

**Mach aus Arbeit in deinen anderen Tools Specs.** Wenn dein Assistent auch GitHub, Jira, Gmail oder Slack verbunden hat, kann er die Arbeit für dich nach Specrails holen:
> *„Nimm die diese Woche offenen GitHub-Issues mit dem Label ‚bug', erstelle für jedes eine Spec im API-Projekt und starte sie."*
>
> *„Lies meine neuesten Kundenfeedback-E-Mails, gruppiere sie nach Thema und erstelle pro Thema eine Spec."*

**Autopilot über Nacht.** Lass es mit der App im Tray laufen und komm zu einem Bericht zurück:
> *„Hier sind 12 Ideen. Mach aus jeder eine Spec, starte sie zu dritt über die Rails, beobachte jeden Job und gib mir morgen eine Zusammenfassung, was fertig wurde, was fehlschlug und was es gekostet hat."*

Wähle **Destruktiv** ab, und es kann die ganze Nacht bauen, ohne jemals etwas zu löschen.

**Über alle deine Projekte hinweg.** Etwas, das das Dashboard von allein nicht kann:
> *„Prüfe alle meine Projekte. Sag mir, welche Specs im Backlog haben und kein laufendes Rail, und starte in jedem das mit der höchsten Priorität."*

**Freihändig, während du programmierst.** Steuere Specrails aus deinem Editor oder per Sprache, ohne das Fenster zu wechseln:
> *„Starte Rail 0 mit Opus für Spec #42 und sag mir, wenn es fertig ist."*

**Frag nach Kosten und Verlauf.** Deine Analytics, in einfacher Sprache:
> *„Wofür habe ich diese Woche am meisten für KI ausgegeben, nach Projekt und nach Modell? Zeig mir die fünf teuersten Specs."*

**Dein tägliches Standup.**
> *„Schreib mein Standup: welche Rails gestern liefen, was abgeschlossen wurde, was fehlschlug, Gesamtkosten — als Stichpunkte, fertig zum Einfügen in Slack."*

**Den Code verstehen.** Kein Editor nötig:
> *„Welche Dateien hat Spec #38 berührt? Fasse in einer Zeile zusammen, was sich in jeder geändert hat."*

Da dein Assistent zuerst das eingebaute Guide liest, musst du selten Tools oder Specs benennen — beschreibe das Ergebnis, und er findet die passenden Aufrufe heraus.

## Ein paar Dinge, die du wissen solltest

- **Specrails muss laufen.** Der MCP-Server lebt innerhalb der App, sodass dein Assistent ihn nur erreichen kann, solange Specrails geöffnet ist. Dank des Tray-Symbols hält das Schließen des Fensters die App im Hintergrund am Laufen — nur **Beenden** über das Tray (Mac-Menüleiste / Windows-Infobereich) stoppt sie wirklich.
- **Lange Aktionen streamen.** Ein Rail zu starten oder eine Spec zu generieren, kehrt sofort zurück und läuft im Hintergrund zu Ende; dein Assistent kann es „beobachten" und sich zurückmelden, sobald es abgeschlossen ist.
- **Sicherheit.** MCP verwendet seinen eigenen Zugriffstoken, getrennt von allem anderen, und lauscht nur auf deinem eigenen Rechner (Loopback). Der Token kann sich nicht als Agentenmodus ausgeben, indem er Stufen-, Projekt- oder Gesprächs-Header mitschickt: Der eingebettete Agent nutzt eine private, kurzlebige, vom Server ausgestellte Berechtigung. Du kannst den begrenzten Token jederzeit aus dem Panel kopieren oder neu generieren.
- **Nicht freigegeben (v1).** Aus Sicherheitsgründen können externe MCP-Clients keine rohen Shell-Befehle im Terminal ausführen, den eingebetteten Browser nicht nutzen, keine Dateien in der App bearbeiten und keine System-Voraussetzungen installieren. Der Agentenmodus hat einen eigenen, authentifizierten Weg für bestätigte, lang laufende Hintergrundbefehle mit der Berechtigung Autonom; externe Clients bekommen ihn nicht, indem sie Destruktiv aktivieren. Alles andere, was Specrails *verwaltet*, ist verfügbar.

Du kannst MCP jederzeit über dasselbe Panel deaktivieren — dein Assistent verliert dann einfach den Zugriff, und sonst ändert sich nichts.
