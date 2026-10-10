# Projektumgebung

Manche Projekte brauchen zur Laufzeit ein Zugangsdatum, etwa `NODE_AUTH_TOKEN` für private npm-Pakete. Füge unter **Projekteinstellungen → Umgebung** die **Namen** der Variablen hinzu, die deine Rails und Loops brauchen. Specrails speichert nur die Namen, nie die Werte.

## Woher die Werte kommen

Beim Start eines Laufs liest Specrails jeden konfigurierten Namen aus der Umgebung, mit der es gestartet wurde. Öffnest du Specrails über das Dock oder den Finder, enthält diese Umgebung nicht, was dein Shell-Profil exportiert. Deshalb liest Specrails fehlende Namen zusätzlich aus deiner Login-Shell (zum Beispiel `~/.zprofile` oder `~/.zshrc`). Bewahre das echte Zugangsdatum in deinem Shell-Profil auf, nicht im Repository.

Die Prüfung läuft im Hintergrund, wenn das Projekt geöffnet wird, wenn du die Namen änderst, und danach regelmäßig. Ein langsames Profil verzögert deine Läufe also nicht. Die Werte bleiben nur für dieses Projekt im Speicher.

## Die Statuschips lesen

Jeder gespeicherte Name zeigt einen Chip:

| Chip | Bedeutung | Was tun |
|------|-----------|---------|
| **Geerbt** | Specrails wurde mit der Variable gestartet. | Nichts. |
| **Aus Login-Shell** | Specrails hat sie aus deiner Login-Shell gelesen. | Nichts. |
| **Nicht definiert** | Deine Login-Shell exportiert sie nicht. | Füge ein `export` in dein Shell-Profil ein. |
| **Shell-Zeitüberschreitung** | Deine Login-Shell brauchte zu lange zum Starten. | Beschleunige das Profil oder erhöhe `SPECRAILS_LOGIN_SHELL_TIMEOUT_MS` (Standard 10 Sekunden). |
| **Shell-Prüfung fehlgeschlagen** | Specrails konnte deine Login-Shell nicht lesen. | Korrigiere das Profil oder starte Specrails aus einem Terminal. |

Fahre mit der Maus über einen Chip, um die Erklärung zu sehen. Klicke nach der Korrektur deines Profils auf **Erneut prüfen**: Ein Neustart von Specrails ist nicht nötig.

Startet ein Lauf mit einem ungelösten Namen, zeigt sein Log eine `[environment]`-Zeile mit der Variable und ihrem Status. Der Lauf startet trotzdem. Der Wert erscheint nie in der App, in den Logs oder in den MCP-Tools.

Unter Windows verwendet Specrails nur die Umgebung, mit der es gestartet wurde.
