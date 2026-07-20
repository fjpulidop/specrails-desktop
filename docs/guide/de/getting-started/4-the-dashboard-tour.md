# Die Dashboard-Tour

Mit einem hinzugefügten Projekt blickst du nun auf dein **Projekt-Dashboard** – deine Basis, um Specs in ausgelieferten Code zu verwandeln. So findest du dich zurecht.

## Das große Ganze

Das Fenster hat drei Bereiche:

- **Linke Seitenleiste** – deine Projektliste. Klicke auf ein beliebiges Projekt, um sofort dorthin zu wechseln; alles andere im Fenster passt sich an. Auch die Schaltfläche **Projekt hinzufügen** ist hier zu Hause.
- **Hauptbereich** – das Dashboard des aktiven Projekts: deine Specs und die Pipeline, die sie ausführt.
- **Rechte Seitenleiste** – Navigation zwischen den Abschnitten des aktuellen Projekts.

## Das Haupt-Dashboard

Hier passiert die Arbeit. Das Dashboard zeigt:

- **Deine Specs** – die Tickets, die du erstellt hast, nach Status sortiert (Backlog/To-do bis Fertig). Du kannst sie als Liste, als Raster oder als Haftnotiz-Karten anzeigen, ganz wie du magst.
- **Eine Möglichkeit, eine Spec hinzuzufügen** – starte eine neue Aufgabe. Du kannst direkt eine schnelle Spec schreiben oder einen geführten **Explore**-Chat öffnen, der dir hilft, sie im Gespräch zu formen und das Ticket für dich zu entwerfen.
- **Rails** – das sind die Spuren, auf denen Specs gebaut werden. Lege eine Spec auf ein Rail und starte sie, um sie durch die Pipeline Architect → Developer → Reviewer → Ship zu schicken. Mehrere Rails können gleichzeitig laufen, sodass du an mehreren Dingen parallel arbeiten kannst.

Während eine Spec läuft, siehst du ihren Pipeline-Fortschritt und Live-Logs – die Echtzeit-Ausgabe der KI, während sie deine Änderung entwirft, programmiert und prüft.

## Die rechte Seitenleiste: Projektabschnitte

Die rechte Seitenleiste ist deine Schaltzentrale für das aktuelle Projekt. Fahre mit der Maus darüber, um sie auszuklappen, oder pinne sie offen an. Diese Abschnitte findest du:

- **Dashboard** – das Specs-Board und die Rails (wo du gerade warst).
- **Jobs** – jeder Pipeline-Lauf dieses Projekts, vergangen und aktuell, mit Status, Dauer und der Möglichkeit, in die Details und Logs jedes Laufs einzutauchen.
- **Analytics** – Aufrufe nach Tag, Aktivität, Modell und Ticket. Claude meldet abgerechnete Kosten, Codex/Gemini Schätzwerte; Kimi lässt nicht verfügbare Token-/USD-Felder leer.
- **Agenten** – provider-spezifische Profile und Rollenkataloge für Claude und Kimi. Kimi-Rollen lassen sich manuell erstellen und bearbeiten; Generate, Test und AI Refine sind nicht verfügbar.
- **Code** – ein schreibgeschützter Datei-Browser mit Chips für von der KI berührte Dateien. KI-Zusammenfassungen in einfacher Sprache erscheinen nur bei kompatiblen Providern und sind mit Kimi nicht verfügbar.
- **Integrationen** – optionale Erweiterungen, etwa das Verbinden deiner Specs mit einem **Jira**-Board oder das Aktivieren zusätzlicher Werkzeuge für die KI.
- **Einstellungen** – projektspezifische Optionen (Telemetrie, Budgets, Provider-Konfiguration und mehr).

> Abschnitte und Aktionen richten sich nach den Fähigkeiten des effektiven Providers. Profile funktionieren etwa mit Claude und Kimi; Agent Studios KI-Aktionen werden mit Kimi dagegen sicher abgelehnt.

## Die Statusleiste

Ein schmaler Streifen verläuft ganz unten am Fenster. Klein, aber praktisch:

- **Verbindungsanzeige** (links) – ein farbiger Punkt mit Beschriftung, der zeigt, dass die App aktiv ist: Grün für *verbunden*, Bernstein während des *Neuverbindens*, Blau während des *Synchronisierens* direkt nach einer erneuten Verbindung. Du wirst sie selten brauchen, aber wenn doch, beruhigt sie.
- **Gesamtausgaben** (rechts) – eine laufende Summe dessen, was du ausgegeben hast, sodass die Kosten immer nur einen Blick entfernt sind.
- **Terminal-Umschalter** (ganz rechts) – öffnet das integrierte Terminal-Panel. Drücke **Cmd+J** (macOS) oder **Ctrl+J** (Windows/Linux), um es jederzeit ein- oder auszublenden. Es ist eine vollwertige Shell, direkt in deinem Projektordner geöffnet.

## Ein paar praktische Tastenkürzel

- **Cmd/Ctrl+B** – Seitenleisten anpinnen oder einklappen.
- **Cmd/Ctrl+J** – Terminal-Panel ein-/ausblenden.
- **Cmd/Ctrl+K** – Suche öffnen.

## Wie es weitergeht

Das war die grobe Übersicht. Von hier aus ist der natürliche erste Schritt, eine **Spec hinzuzufügen** und sie auf einem Rail zu starten – schau der Pipeline von Anfang bis Ende zu und prüfe dann unter **Analytics**, was sie gekostet hat. Willkommen an Bord.
