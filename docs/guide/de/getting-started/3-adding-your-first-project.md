# Dein erstes Projekt hinzufügen

Ein Projekt ist einfach ein Ordner auf deinem Computer, der eine Codebasis enthält. Verbinden wir eins.

## Den Dialog „Projekt hinzufügen“ öffnen

Klicke auf dem Willkommensbildschirm auf **Dein erstes Projekt hinzufügen** (oder später auf die Schaltfläche **Projekt hinzufügen** in der linken Seitenleiste). Ein kleiner Dialog erscheint.

## Die Details ausfüllen

**Projektordner** *(erforderlich)*

Zeige specrails den Ordner, der deinen Code enthält. In der Desktop-App kannst du auf das Ordnersymbol klicken, um ihn visuell auszuwählen, oder den vollständigen Pfad einfügen. Das sollte das Wurzelverzeichnis deines Repositorys sein – der Ordner, der deinen Code und (üblicherweise) ein `.git`-Verzeichnis enthält.

**Projektname** *(optional)*

Ein freundliches Label, das in der Seitenleiste angezeigt wird. Lässt du es leer, verwendet specrails den Ordnernamen.

**Provider**

Wähle, welche KI-Provider dieses Projekt nutzen soll. specrails zeigt dir die, die es auf deinem Rechner gefunden hat:

- 🤖 **Claude**
- ⚡ **Codex**
- ✨ **Gemini**

Nicht gefundene Provider sind ausgegraut und als *nicht gefunden* markiert – installiere einen, melde dich an und öffne den Dialog dann erneut. Standardmäßig ist jeder verfügbare Provider vorausgewählt, du kannst die Auswahl aber auf genau den reduzieren, den du möchtest. Wählst du mehr als einen, wird der **erste** zum Standard des Projekts; pro Aufgabe kannst du später trotzdem wählen.

> Im Hintergrund läuft eine schnelle Prüfung, um sicherzustellen, dass die benötigten Tools vorhanden sind. Fehlt etwas Wesentliches, bleibt die **Hinzufügen**-Schaltfläche deaktiviert, und ein **Weitere Informationen**-Link liefert dir die genauen Installationsbefehle.

Klicke auf **Hinzufügen**, um fortzufahren.

## Setup, das in Sekunden läuft

Ist der Ordner bereits für specrails konfiguriert, bist du fertig – das Projekt erscheint sofort in deiner Seitenleiste.

Handelt es sich um ein frisches Projekt, läuft ein kurzer **Einrichtungsassistent**. Er hat drei Schritte:

1. **Konfigurieren** – bestätige die Grundlagen für jeden Provider, den du ausgewählt hast.
2. **Installieren** – specrails richtet das Projekt automatisch ein. Das ist die *schnelle* Installation: einsatzbereite Vorlagen-Agenten, die in Sekunden bereitstehen. Du siehst dabei ein Live-Log.
3. **Fertig** – eine Zusammenfassung, die bestätigt, dass alles bereit ist.

Bei einem Projekt mit mehreren Providern läuft die Installation einmal pro Provider, nacheinander, und der Schritt „Fertig“ zeigt für jeden eine eigene Karte.

## Was installiert wird

Das Setup ist bewusst schlank und **nicht-invasiv**. specrails fügt deinem Projekt eine kleine Menge Konfiguration hinzu, damit die Pipeline weiß, wie sie laufen soll:

- Einen `.specrails/`-Ordner, der die Agent-Profile und lokalen Einstellungen deines Projekts enthält.
- Agent-Definitionen unter `.claude/agents/`, die die Pipeline Architect → Developer → Reviewer → Ship antreiben.

Mehr nicht – specrails schreibt deinen Quellcode beim Setup nicht um, und diese Dateien lassen sich problemlos committen, wenn du die Konfiguration mit deinem Team teilen möchtest.

> **Lieber das tiefgehende Setup?** Die App liefert bewusst die schnelle Vorlagen-Installation. Wenn du den KI-angereicherten Ablauf bevorzugst (Codebasis-Analyse und individuelle Agent-Personas), kannst du `npx specrails-core@latest init` aus deinem Projektordner in einem Terminal ausführen.

## Du bist drin

Sobald das Setup abgeschlossen ist, setzt specrails dich direkt ins Dashboard deines Projekts. Zeit für die Tour – siehe [Die Dashboard-Tour](the-dashboard-tour).
