# Wenn der lokale Server stoppt {#server-recovery}

Specrails betreibt auf Ihrem Computer einen kleinen Server, der Ihre Projekte, Rails, Missionen und Terminals am Laufen hält. Die Desktop-App überwacht ihn und startet ihn neu, wenn er stoppt.

## Was passiert, wenn der Server stoppt

- **Specrails startet ihn für Sie neu.** Der Server kommt unter derselben Adresse zurück und offene Fenster verbinden sich von selbst neu; die Statusleiste zeigt einige Sekunden lang **verbinde neu…**.
- **Ein Banner erklärt, was passiert ist**: wann der Server gestoppt hat und warum (ein Exit-Code oder ein Signal). Arbeit, die in diesem Moment lief, wurde möglicherweise unterbrochen: Prüfen Sie ihren Status und starten Sie sie bei Bedarf erneut.
- **Höchstens drei Neustarts pro Minute.** Stoppt der Server immer wieder, hört Specrails mit den Neustarts auf, um kein Problem zu verdecken, und zeigt einen Dialog. Wählen Sie **Try again**, um ihn jetzt zu starten, oder beenden Sie Specrails und öffnen Sie es erneut. Ihre gespeicherten Projekte bleiben auf der Festplatte.
- **Auch der nächste Start erklärt es.** Wurde Specrails geschlossen, während der Server gestoppt war, erscheint das Banner beim nächsten Öffnen.

Wählen Sie **Schließen** im Banner, wenn Sie es gelesen haben; für diese Stopps erscheint es nicht mehr.

## Problem melden {#report-a-problem}

**Problem melden** speichert auf Ihrem Computer ein ZIP, das hilft zu verstehen, was schiefgelaufen ist. Es wird nichts hochgeladen: Sie entscheiden, ob und mit wem Sie es teilen.

Sie öffnen es über:

- **Problem melden** im Banner,
- **Einstellungen ▸ Info ▸ Problem melden**,
- die Befehlspalette (**⌘K**), indem Sie *Problem melden* eingeben.

Vor dem Speichern listet das Fenster jede Datei des Berichts auf und zeigt ihren Inhalt. Das ZIP enthält genau das, was Sie sehen:

| Datei | Inhalt |
| --- | --- |
| `README.txt` | Was der Bericht ist und was jede Datei enthält |
| `system.json` | App- und Core-Version, Betriebssystem, Speicher |
| `settings.json` | App-Einstellungen ohne Tokens, Schlüssel, Passwörter, Umgebungswerte und Header |
| `server.log` | Ausgabe des laufenden Servers seit seinem Start |
| `sidecar-stderr.log` | Aktuelle Fehlerausgabe des Servers, auch früherer, gestoppter Läufe (Desktop-App) |
| `desktop.log` | Wann der Server gestartet, gestoppt und neu gestartet wurde (Desktop-App) |
| `crashes.json` | Jeder unerwartete Stopp mit seinen letzten Fehlerzeilen |
| `stalls.json` | Momente, in denen der Server nicht reagierte |

Tokens, API-Schlüssel, Passwörter, private Schlüssel und Zugangsdaten in URLs werden durch `[REDACTED]` ersetzt, Ihr Benutzerordner erscheint als `~`. Lesen Sie die Dateien trotzdem, bevor Sie sie teilen: Ein Projekt- oder Dateiname, den Sie als privat ansehen, kann vorkommen.

## Reaktionsfähigkeit {#responsiveness}

Das Popover **Ressourcen** in der Statusleiste zeigt auch die **Reaktionsfähigkeit**: wie oft der Server 200 ms oder länger nicht antworten konnte, den längsten dieser Momente und was er gerade tat. Häufige lange Hänger sind einen Bericht wert.
