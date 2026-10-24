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
- **Integrationen** – optionale Erweiterungen, etwa das Verbinden deiner Specs mit einem **Jira**-Board oder das Aktivieren zusätzlicher Werkzeuge für die KI.
- **Einstellungen** – projektspezifische Optionen (Telemetrie, Budgets, Provider-Konfiguration und mehr).

## Die Statusleiste

Ein schmaler Streifen verläuft ganz unten am Fenster. Klein, aber praktisch:

- **Verbindungsanzeige** (links) – ein farbiger Punkt mit Beschriftung, der zeigt, dass die App aktiv ist: Grün für *verbunden*, Bernstein während des *Neuverbindens*, Blau während des *Synchronisierens* direkt nach einer erneuten Verbindung. Du wirst sie selten brauchen, aber wenn doch, beruhigt sie.
- **Gesamtausgaben** (rechts) – eine laufende Summe dessen, was du ausgegeben hast, sodass die Kosten immer nur einen Blick entfernt sind.
- **Terminal-Umschalter** (ganz rechts) – öffnet das integrierte Terminal-Panel. Drücke **Cmd+J** (macOS) oder **Ctrl+J** (Windows/Linux), um es jederzeit ein- oder auszublenden. Es ist eine vollwertige Shell, direkt in deinem Projektordner geöffnet.

## Ein paar praktische Tastenkürzel

- **Cmd/Ctrl+B** – linke Seitenleiste anpinnen oder einklappen; **Option+Cmd+B** (**Ctrl+Alt+B**) macht dasselbe mit der rechten.
- **Cmd/Ctrl+J** – Terminal-Panel ein-/ausblenden.
- **Cmd/Ctrl+K** – die Befehlspalette: Missionen, Projekte und Jobs suchen und **Aktionen ausführen**. Tippen Sie ein Verb („neu“, „starten“, „verschieben“, „wechseln“) oder beginnen Sie mit **>**, um Aktionen aufzulisten: Neue Spec (auch im Erkunden-Modus), Spec starten oder verschieben, ihr Review öffnen, einen Flow übergeben oder pausieren, Neue Mission, Theme wechseln, zwischen Mission- und Board-Modus wechseln, App- oder Projekteinstellungen in einem Bereich öffnen, einen Loop ausführen, Seitenleisten umschalten, Zurück oder Vorwärts, die letzte Änderung rückgängig machen und Kürzlich gelöscht. Aktionen, die eine Auswahl brauchen (Rail, Status, Theme, Bereich), öffnen eine zweite Seite; **Rücktaste** bei leerer Suche geht zurück. Jede Aktion zeigt ihr Tastenkürzel, die Palette bringt Ihnen also die Tasten bei. Sie bietet nur an, was dort funktioniert, wo Sie sind, und befolgt dieselben Regeln wie die Schaltflächen (eine nicht startbare Spec wird nicht angeboten). Bei leerer Suche listet sie Ihre **zuletzt verwendeten Aktionen** und **zuletzt besuchten Orte**.
- **Cmd+[ / Cmd+]** (**Alt+← / Alt+→** unter Windows/Linux), die Schaltflächen **←  →** in der Titelleiste oder die Zurück-/Vor-Tasten der Maus – gehen durch die besuchten Orte: Specs, Missionen, Jobs, Projekte und Vollbild-Panels. Rechtsklick (oder langes Drücken) auf eine Schaltfläche zeigt die letzten Orte.
- **Cmd+Umschalt+I** (**Strg+Umschalt+I**) oder die Schaltfläche **Posteingang** in der Titelleiste — der Posteingang **Braucht dich**: alles, was in all deinen Projekten auf dich wartet, in einer Liste nach Projekt gruppiert. Er sammelt Reviews, die entschieden werden können, Fragen, auf die ein Agent wartet, fehlgeschlagene oder blockierte Läufe, am Tagesbudget pausierte Läufe und Jira-Updates, die sich nicht synchronisieren ließen. Jede Zeile hat ihre Hauptaktion direkt dabei (**Review öffnen**, **Antworten**, **Fortsetzen**, **Wiederholen**) sowie **Zurückstellen** (1 Stunde oder bis morgen) und **Erledigt**. Ein zurückgestellter oder erledigter Eintrag kommt von selbst wieder, wenn sich sein Zustand ändert. Die Schaltfläche zeigt, wie viele Einträge warten, und eine Anbieter-Limit-Benachrichtigung öffnet den Posteingang. Der Posteingang ist außerdem ein Link (`?inbox=1`) und eine Aktion der Befehlspalette.

## Wie es weitergeht

Das war die grobe Übersicht. Von hier aus ist der natürliche erste Schritt, eine **Spec hinzuzufügen** und sie auf einem Rail zu starten – schau der Pipeline von Anfang bis Ende zu und prüfe dann unter **Analytics**, was sie gekostet hat. Willkommen an Bord.
