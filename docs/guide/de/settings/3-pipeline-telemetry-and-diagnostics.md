# Pipeline-Telemetrie & Diagnose

Wenn ein Pipeline-Job nicht so läuft, wie du es erwartet hast, liefert dir die Telemetrie eine detaillierte Aufzeichnung dessen, was die AI-CLI hinter den Kulissen tatsächlich getan hat. Sie ist **standardmäßig aus** und vollständig optional, pro Projekt – aktiviere sie nur dann, wenn du sie wirklich willst.

## Was es ist

Die Telemetrie erfasst strukturierte Diagnosesignale (Traces, Metriken und Logs), die die AI-CLI während eines Pipeline-Jobs aussendet. Stell es dir wie einen Flugschreiber für deine Pipeline-Läufe vor: Zeitabläufe, Token-Verbrauch und die Aktivität Schritt für Schritt – lokal aufgezeichnet, damit du einen Job im Nachhinein untersuchen kannst.

Es baut auf **OpenTelemetry** auf, einem offenen Standardformat – die Daten sind also nicht in einer proprietären Blackbox eingesperrt.

## Aktivieren

Die Telemetrie wird **pro Projekt** konfiguriert:

1. Öffne die **Einstellungen** des Projekts (die projektspezifische Einstellungsseite).
2. Suche den Schalter **Pipeline-Telemetrie**.
3. Schalte ihn ein.

Ab diesem Moment zeichnen Pipeline-Jobs in diesem Projekt Telemetrie auf. Andere Projekte bleiben davon unberührt – jedes Projekt entscheidet für sich selbst.

### Was abgedeckt ist

Die Telemetrie gilt für **Pipeline-Jobs** (die in der Queue eingereihten Architect → Developer → Reviewer → Ship-Rail-Läufe). Interaktive Sitzungen wie der Chat und der Einrichtungsassistent sind bewusst ausgenommen – die Telemetrie ist für die wiederholbaren, untersuchbaren Pipeline-Läufe gedacht, nicht für einmalige Unterhaltungen.

## Wo die Daten liegen

Alles bleibt auf deinem Rechner, in deinem Home-Verzeichnis (`~/.specrails/`) – niemals in deinem Repository. Die Rohaufzeichnungen werden komprimiert neben ihrem Job gespeichert, und ältere Aufzeichnungen werden nach einer Woche automatisch zu kompakten Zusammenfassungen verdichtet, damit alles aufgeräumt bleibt. Du musst nichts davon von Hand verwalten.

## Ein Diagnose-Paket exportieren

Das Nützlichste, was die Telemetrie ermöglicht, ist der **Diagnose-Export** – ein einzelnes ZIP, das alles zu einem Job bündelt, um Probleme zu untersuchen oder Informationen zu teilen.

Sobald für einen Job Telemetrie aufgezeichnet wurde, erscheint auf seiner Job-Karte eine **Export-Schaltfläche**. Klick darauf, um ein ZIP herunterzuladen, das Folgendes enthält:

- **`job-metadata.json`** – Identität und Parameter des Jobs
- **`telemetry.ndjson`** – die aufgezeichneten Rohsignale
- **`logs.txt`** – die erfasste Log-Ausgabe
- **`summary.md`** – eine gut lesbare Zusammenfassung des Laufs

Verwendet das Projekt Plugins, enthält das Paket zusätzlich eine Momentaufnahme, welche Plugins für diesen Job aktiv waren.

Genau dieses Paket schnappst du dir, wenn du einen kniffligen Lauf nachvollziehen, eine Aufzeichnung aufbewahren oder jemandem die Details geben willst, der dir beim Debuggen hilft.

## Deaktivieren

Stell den Schalter jederzeit wieder aus. Neue Jobs hören sofort auf aufzuzeichnen. Was bereits erfasst wurde, bleibt auf der Festplatte, bis es verdichtet wird oder du das Projekt entfernst – nichts wird irgendwohin gesendet oder hinter deinem Rücken verloren.
