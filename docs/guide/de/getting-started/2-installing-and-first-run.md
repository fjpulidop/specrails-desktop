# Installation & erster Start

specrails auf deinen Rechner zu bekommen, dauert nur ein paar Minuten. Hier ist der gesamte Ablauf.

## 1. Herunterladen und installieren

Schnapp dir den Installer für deine Plattform:

- **macOS (Apple Silicon)** – eine `.dmg`-Datei. Öffne sie und zieh **specrails** in deinen Programme-Ordner.
- **Windows** – ein `.exe`-Setup-Installer. Führe ihn aus und folge den Anweisungen.

> **Hinweis zu Sicherheitsmeldungen unter macOS und Windows**
>
> - Unter **Windows** ist der Installer noch nicht code-signiert, deshalb zeigt SmartScreen möglicherweise eine Warnung. Klicke auf **Weitere Informationen → Trotzdem ausführen**, um fortzufahren.
> - Unter **macOS** ist die App signiert und notarisiert, sie sollte sich also problemlos öffnen.

## 2. Was du brauchst (Voraussetzungen)

specrails führt KI-Entwicklungs-Pipelines aus, indem es echte Kommandozeilen-Tools ansteuert – ein paar Dinge müssen also verfügbar sein. Die gute Nachricht: Die Desktop-App **bringt die meisten davon schon für dich mit** (Node.js, npm und Git stecken in der App), sodass auf einem frischen Rechner meist nichts zu installieren ist.

Das Einzige, was specrails nicht mitbringen kann, ist die **KI-Provider-CLI** selbst. Du brauchst mindestens eine davon:

- **Claude Code**
- **Codex CLI**
- **Gemini CLI**

Installiere die, die du nutzen möchtest, melde dich einmal über dein Terminal an – fertig. specrails erkennt automatisch, welche Provider vorhanden sind.

> Falls einmal ein Tool als fehlend markiert wird, zeigt die App einen **Weitere Informationen**-Link mit Installationsbefehlen zum Kopieren, passend zu deinem Betriebssystem (Homebrew unter macOS, winget unter Windows, apt/dnf unter Linux). Du kannst jederzeit erneut prüfen, ohne neu zu starten.

## 3. Erster Start – der Willkommensbildschirm

Wenn du specrails zum ersten Mal öffnest, landest du auf einem aufgeräumten **Willkommensbildschirm**. Es gibt noch keine Projekte, deshalb lädt dich die App ein, dein erstes hinzuzufügen.

Du siehst:

- Eine kurze Beschreibung dessen, was specrails leistet.
- Eine einzelne Schaltfläche **Dein erstes Projekt hinzufügen**.

Das ist das gesamte Onboarding – kein Konto anzulegen, keine Registrierung. specrails läuft komplett auf deinem Rechner.

Klicke auf **Dein erstes Projekt hinzufügen** und weiter geht's mit [Dein erstes Projekt hinzufügen](adding-your-first-project).
