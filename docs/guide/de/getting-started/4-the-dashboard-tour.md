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
- **Analytics** – was deine KI-Nutzung kostet. Ausgaben aufgeschlüsselt nach Tag, nach Aktivität, nach Modell und nach Ticket – damit es keine Überraschungen gibt.
- **Agenten** – die Agent-Profile deines Projekts: welche Agenten in der Pipeline laufen und welche KI-Modelle sie nutzen. *(Nur bei Claude-betriebenen Projekten.)*
- **Code** – ein schreibgeschützter Datei-Browser mit KI-Zusammenfassungen in einfacher Sprache und Chips, die zeigen, welche Dateien die KI angefasst hat. Ideal für Nicht-Entwickler, die mitverfolgen möchten.
- **Integrationen** – optionale Erweiterungen, etwa das Verbinden deiner Specs mit einem **Jira**-Board oder das Aktivieren zusätzlicher Werkzeuge für die KI.
- **Einstellungen** – projektspezifische Optionen (Telemetrie, Budgets, Provider-Konfiguration und mehr).

> Manche Abschnitte erscheinen nur, wenn sie für die gewählten Provider sinnvoll sind – zum Beispiel ist **Agenten** spezifisch für Claude. Siehst du einen Abschnitt nicht, gilt er für das Setup dieses Projekts schlicht nicht.

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
