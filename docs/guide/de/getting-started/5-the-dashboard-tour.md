# Die Dashboard-Tour

Mit einem hinzugefügten Projekt blickst du nun auf dein **Projekt-Dashboard** – deine Basis, um Specs in ausgelieferten Code zu verwandeln. So findest du dich zurecht.

## Das große Ganze

Das Fenster hat drei Bereiche:

- **Linke Seitenleiste** – deine Projektliste. Klicke auf ein beliebiges Projekt, um sofort dorthin zu wechseln; alles andere im Fenster passt sich an. Auch die Schaltfläche **Projekt hinzufügen** ist hier zu Hause.
- **Hauptbereich** – das Dashboard des aktiven Projekts: deine Specs und die Pipeline, die sie ausführt.
- **Rechte Seitenleiste** – Navigation zwischen den Abschnitten des aktuellen Projekts.

## Das Haupt-Dashboard

Hier passiert die Arbeit. Das Dashboard zeigt:

- **Deine Specs** – die Specs, die du erstellt hast, nach Status sortiert (Backlog/To-do bis Fertig). Du kannst sie als Liste, als Raster oder als Haftnotiz-Karten anzeigen, ganz wie du magst.
- **Eine Möglichkeit, eine Spec hinzuzufügen** – starte eine neue Aufgabe. Du kannst direkt eine schnelle Spec schreiben oder einen geführten **Explore**-Chat öffnen, der dir hilft, sie im Gespräch zu formen, und die Spec für dich entwirft.
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
- **Ressourcen** (rechts) – wie viel CPU und Arbeitsspeicher alles, was Specrails gestartet hat, gerade nutzt, und wie viele Prozesse. Klicke darauf für die Summen, einen Speicherverlauf und die Aufteilung nach Quelle: Missionen & Chats, Rails, Loops & Jobs, Hintergrundprozesse, Terminals, Agenten-CLIs, MCP & Runner, Git und der Specrails-Server selbst. Klappe eine Quelle auf, um ihre Prozesse zu sehen. Unter den Quellen zeigt **Ports der Lauf-Worktrees**, welche Ports der Entwicklungs- oder Testserver jeder Rail bedient (Rail, Spec, Projekt und Prozess), und warnt, wenn ein anderer Prozess in den zugewiesenen Ports einer Rail sitzt.
- **Terminal-Umschalter** (ganz rechts) – öffnet das integrierte Terminal-Panel. Drücke **Cmd+J** (macOS) oder **Ctrl+J** (Windows/Linux), um es jederzeit ein- oder auszublenden. Es ist eine vollwertige Shell, direkt in deinem Projektordner geöffnet.

## Eigene Fenster

In der Desktop-App öffnen sich manche Bildschirme als echte Fenster statt als Panels im Hauptfenster: die **Einstellungen**, die Details eines aus einer Mission geöffneten Jobs sowie **Loops** und **Plugins** im Mission-Modus. Du kannst sie auf einen anderen Bildschirm schieben und im Hauptfenster weiterarbeiten. Jedes nutzt die systemeigenen Fenstersteuerungen; die Einstellungen und das Job-Fenster schließen sich außerdem mit **Escape**. Änderungen, die du dort machst, etwa am Theme oder an der Sprache, gelten sofort auch im Hauptfenster. In der Browser-Version öffnen sich diese Bildschirme als Panels.

## Benachrichtigungen über das, was auf dich wartet {#attention}

Specrails sagt dir Bescheid, wenn etwas auf dich wartet: eine Frage oder die Antwort einer Mission, ein Review, das eine Entscheidung braucht, ein Lauf, der fehlgeschlagen, blockiert oder stehen geblieben ist, ein Ausgabenlimit und ein fertiger Job. Wie, hängt davon ab, wo du bist:

- **Nicht in der App** — eine Systembenachrichtigung mit Projekt und Ursache. In der Desktop-App lässt sie sich nicht anklicken; wenn du zurückkommst, fasst ein Hinweis alles zusammen (**3 Sachen warten auf dich**) und öffnet den Eintrag, bei mehreren den Posteingang **Offen**.
- **Woanders in der App** — ein kleiner Hinweis mit **Öffnen**.
- **Du siehst es schon** — nichts. Eine Mission, die du gerade ansiehst, meldet ihre eigenen Antworten nicht; ein hängender Lauf ist die Ausnahme und meldet sich immer.

Jeder neue Zustand eines Eintrags wird einmal gemeldet; nach einem Neustart wird nichts Altes erneut gemeldet. Im Posteingang tragen Einträge, die du noch nicht gesehen hast, einen Punkt; **Als ungelesen markieren** und **Als gelesen markieren** ändern ihn. In der Desktop-App zeigt das Dock-Symbol (unter Linux der Starter), wie viele Einträge du noch nicht gesehen hast.

Was gemeldet wird, wählst du unter **Einstellungen ▸ Benachrichtigungen**: alles ausschalten, Kategorien wählen (Fragen und Antworten, Reviews, Fehler, Ausgabenlimits, fertige Jobs), einen Ton hinzufügen, das Dock-Badge ausblenden oder ein Projekt ausschalten. Die Glocke neben einem Projektnamen im Posteingang schaltet es ebenfalls stumm; seine Einträge bleiben im Posteingang.

## Das Live-Board {#live-board}

Das **Live-Board** zeigt jeden Lauf aus jedem Projekt an einem Ort: Rails, Loops, Intent-Sitzungen und Jobs. Öffne es über **Live-Board** in der linken Seitenleiste, mit **Cmd+Shift+B** (**Ctrl+Shift+B** unter Windows und Linux) oder mit **Live-Board öffnen** in der Befehlspalette. Es ist auch ein Link (`?live=1`), daher schließt **Zurück** es.

Wähle über den Umschalter in der Kopfzeile, wie du es liest (deine Wahl wird gemerkt):

- **Nach Status**: vier Spalten. **Braucht dich** ist genau das, was der Posteingang listet (Fragen, Fehler, blockierte Läufe, Ausgabenlimits, Jira-Updates), die ältesten zuerst. **In Arbeit** enthält, was läuft, danach, was in der Warteschlange steht. **Zu entscheiden** enthält Arbeit, die auf dein Review wartet. **Heute erledigt** enthält, was heute fertig, gemergt oder gestoppt wurde, und leert sich um Mitternacht. Ein Lauf steht immer nur in einer Spalte.
- **Nach Mission**: eine Zeile pro Mission mit jedem Lauf, den sie gestartet hat, ihrem Projekt, der Engine, der Zahl der Läufe und den heutigen Ausgaben. Missionen, die dich brauchen, kommen zuerst; Läufe ohne Mission schließen die Liste unter **Nicht aus einer Mission** ab.

Jede Karte zeigt den Zustand des Laufs, das Projekt, die Rail oder die Art, den Titel, was er gerade tut, seine Schritte, wenn es welche gibt, die Engine, wie lange er läuft oder wartet, und seine Kosten, wenn sie bekannt sind. Eine Frage zeigt ihren Text. Der Button auf der Karte ist dieselbe Aktion wie überall sonst: **Antworten**, **Review öffnen**, **Fortsetzen**, **Wiederholen**, **Limit erhöhen** oder **Öffnen**, das die Mission öffnet, die den Lauf gestartet hat, oder den Lauf selbst. Filtere nach Projekt, nach Art (Rails, Loops, Intent, Jobs) oder nach Engine; die Kopfzeile fasst zusammen, wie viele dich brauchen, wie viele laufen und was du heute ausgegeben hast.

In der Desktop-App öffnet sich das Board immer in einem eigenen Fenster, etwa für einen zweiten Bildschirm: Jeder Weg dorthin holt dieses Fenster nach vorne, und **Cmd+Shift+B** zeigt oder verbirgt es. Seine Buttons wirken im Hauptfenster, das nach vorne kommt.

## Ein paar praktische Tastenkürzel {#shortcuts}

- **Cmd/Ctrl+B** – linke Seitenleiste anpinnen oder einklappen; **Option+Cmd+B** (**Ctrl+Alt+B**) macht dasselbe mit der rechten.
- **Cmd/Ctrl+J** – Terminal-Panel ein-/ausblenden.
- **Cmd/Ctrl+K** – die Befehlspalette: Missionen, Projekte und Jobs suchen und **Aktionen ausführen**. Tippe ein Verb („neu“, „starten“, „verschieben“, „wechseln“) oder beginne mit **>**, um Aktionen aufzulisten: Neue Spec (auch im Erkunden-Modus), Spec starten oder verschieben, ihr Review öffnen, einen Intent übergeben oder pausieren, Neue Mission, Theme wechseln, zwischen Mission- und Board-Modus wechseln, App- oder Projekteinstellungen in einem Bereich öffnen, einen Loop ausführen, Seitenleisten umschalten, Zurück oder Vorwärts, die letzte Änderung rückgängig machen und Kürzlich gelöscht. Aktionen, die eine Auswahl brauchen (Rail, Status, Theme, Bereich), öffnen eine zweite Seite; **Rücktaste** bei leerer Suche geht zurück. Jede Aktion zeigt ihr Tastenkürzel, die Palette bringt dir also die Tasten bei. Sie bietet nur an, was dort funktioniert, wo du bist, und befolgt dieselben Regeln wie die Schaltflächen (eine nicht startbare Spec wird nicht angeboten). Bei leerer Suche listet sie deine **zuletzt verwendeten Aktionen** und **zuletzt besuchten Orte**.
- **Cmd+[ / Cmd+]** (**Alt+← / Alt+→** unter Windows/Linux), die Schaltflächen **←  →** in der Titelleiste oder die Zurück-/Vor-Tasten der Maus – gehen durch die besuchten Orte: Specs, Missionen, Jobs, Projekte und Vollbild-Panels. Rechtsklick (oder langes Drücken) auf eine Schaltfläche zeigt die letzten Orte.
- **Cmd+Umschalt+I** (**Strg+Alt+I** unter Windows und Linux) oder die Schaltfläche **Offen** in der Titelleiste — die Liste **Offen**: alles, was in all deinen Projekten auf dich wartet, in einer Liste nach Projekt gruppiert. Sie sammelt Reviews, die entschieden werden können, Fragen, auf die ein Agent wartet, fehlgeschlagene oder blockierte Läufe, am Tagesbudget pausierte Läufe und Jira-Updates, die sich nicht synchronisieren ließen. Jede Zeile hat ihre Hauptaktion direkt dabei (**Review öffnen**, **Antworten**, **Fortsetzen**, **Wiederholen**) sowie **Zurückstellen** (1 Stunde oder bis morgen) und **Erledigt**. Ein zurückgestellter oder erledigter Eintrag kommt von selbst wieder, wenn sich sein Zustand ändert. Die Schaltfläche zeigt, wie viele Einträge warten, und eine Anbieter-Limit-Benachrichtigung öffnet die Liste. Die Liste ist außerdem ein Link (`?inbox=1`) und eine Aktion der Befehlspalette.
- **M** — öffnet bei einer fokussierten Spec-Karte im Board eine Auswahl, um sie in einen Status oder eine Rail zu verschieben, das Tastaturäquivalent zu Drag and Drop. Es funktioniert auch bei einer Mehrfachauswahl, und die Palette bietet es als **Fokussierte Spec verschieben…** an.
- **?** — die Übersicht der Tastaturkürzel. Tippe in ihr Suchfeld, um die Kürzel zu filtern und passende Seiten und Abschnitte dieser Anleitung zu finden; sie öffnen sich in der Anleitung, ohne dass du deinen Bildschirm verlässt. Die kleinen **ⓘ**-Symbole und **Mehr erfahren**-Links neben Einstellungen, Rails, Intent, dem Kontext-Schieberegler und Budgets öffnen die Anleitung auf dieselbe Weise im passenden Abschnitt.

## Wie es weitergeht

Das war die grobe Übersicht. Von hier aus ist der natürliche erste Schritt, eine **Spec hinzuzufügen** und sie auf einem Rail zu starten – schau der Pipeline von Anfang bis Ende zu und prüfe dann unter **Analytics**, was sie gekostet hat. Willkommen an Bord.
