# Dein erstes Projekt hinzufügen

Ein Projekt ist einfach ein Ordner auf deinem Computer, der eine Codebasis enthält. Verbinden wir eins.

## Den Dialog „Projekt hinzufügen“ öffnen

Klicke auf **Füge dein erstes Projekt hinzu** auf dem Willkommensbildschirm (oder später auf den Button **Projekt hinzufügen** in der linken Seitenleiste). Ein kleiner Dialog erscheint.

## Die Details ausfüllen

**Projektordner** *(erforderlich)*

Zeige specrails den Ordner, der deinen Code enthält. In der Desktop-App kannst du auf das Ordnersymbol klicken, um visuell zu wählen, oder den vollständigen Pfad einfügen. Es sollte die Wurzel deines Repositories sein — der Ordner mit deinem Code und (üblicherweise) einem `.git`-Verzeichnis.

**Projektname** *(optional)*

Eine freundliche Bezeichnung in der Seitenleiste. Lässt du sie leer, verwendet specrails den Ordnernamen.

> Im Hintergrund läuft eine schnelle Prüfung, ob die erforderlichen Tools vorhanden sind. Fehlt etwas Wesentliches, bleibt der **Hinzufügen**-Button deaktiviert und ein **Mehr Infos**-Link liefert dir die genauen Installationsbefehle.

Das ist das ganze Formular — klicke auf **Hinzufügen** und fertig.

## KI-Provider werden automatisch erkannt

Du wählst keine Provider mehr aus. Specrails erkennt jedes auf deinem Rechner installierte KI-CLI — **Claude**, **Codex**, **Gemini**, **Kimi** — und jedes Projekt kann sie alle nutzen, immer. Installierst du später einen neuen Provider, erscheint er beim nächsten Fokussieren der App von selbst überall; keine Neueinrichtung, keine Konfiguration pro Projekt. Ist ein Provider installiert, aber nicht angemeldet, zeigt sein Auswahlmenü ein dezentes *Nicht angemeldet*-Badge.

## Die Einrichtung läuft still im Hintergrund

Es gibt keinen Einrichtungsassistenten. Sobald du auf **Hinzufügen** klickst, ist das Projekt registriert und erscheint in deiner Seitenleiste — du kannst es sofort öffnen. Im Hintergrund baut specrails den Workspace des Projekts zusammen (wenige Sekunden, vollständig offline): Ein kleiner pulsierender Punkt in der Projektzeile zeigt die Arbeit an und verschwindet, sobald alles bereit ist. Schlägt etwas für einen Provider fehl, funktioniert das Projekt mit den anderen weiter — ein bernsteinfarbener Punkt erscheint, ein Klick darauf versucht es erneut.

## Was installiert wird — und wo

Die Einrichtung ist bewusst **nicht-invasiv**: Dein Repository bleibt unberührt. Alle specrails-Artefakte (Agentendefinitionen, Befehle, Profile, lokale Einstellungen) liegen in einem Workspace pro Projekt unter deinem Home-Verzeichnis, verknüpft mit einer einzigen gemeinsamen Framework-Installation, die mit der App ausgeliefert wird. Dein Repo wird nie verändert — und bei einem App-Update erhält jedes Projekt das neue Framework automatisch, auf einmal.

> **Lieber die tiefe Einrichtung?** Die App liefert absichtlich die schnelle Template-Installation. Wenn du den KI-angereicherten Ablauf bevorzugst (Codebasis-Analyse und individuelle Agenten-Personas), kannst du `npx specrails-core@latest init` im Projektordner in einem Terminal ausführen.

## Du bist drin

Das Projekt-Dashboard ist verfügbar, sobald du auf **Hinzufügen** klickst. Zeit für die Tour — siehe [Die Dashboard-Tour](the-dashboard-tour).
