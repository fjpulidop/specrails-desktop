# Analytics & Kostenverfolgung

Jedes Mal, wenn Specrails in deinem Auftrag eine KI-CLI ausführt – einen Pipeline-Job, eine Quick-Spec, eine Explore-Sitzung, eine KI-Bearbeitung, eine Dateizusammenfassung – wird festgehalten, was passiert ist: welches Modell gelaufen ist, wie viele Tokens hinein- und hinausgingen, wie lange es gedauert hat und was es gekostet hat. Der Bereich **Analytics** verwandelt all das in ein einziges Dashboard, damit du immer weißt, wohin deine KI-Ausgaben fließen.

Du öffnest ihn über die rechte Seitenleiste (Beschriftung **Analytics**). Alles, was du siehst, bezieht sich auf das Projekt, in dem du dich gerade befindest – wechselst du das Projekt, ziehen die Zahlen mit.

## Was als Ausgabe zählt

Jeder KI-Aufruf im Projekt zählt: Pipeline-Jobs und Loop-Schritte, das Schreiben von Specs, Dateizusammenfassungen, Nebenchats, Fehlerdiagnosen sowie die Missionen und Intent-Runden, die du mit dem Agenten führst, während er an dieses Projekt angeheftet ist. Missionen auf der Startseite (ohne angeheftetes Projekt) gehören zu keinem Projekt und werden hier nicht gezählt.

Jeder Aufruf wird mit der *Surface* versehen, die die Ausgabe verursacht hat, und jede Surface gehört zu einer von fünf **Kategorien**, die sagen, *wofür* das Geld ausgegeben wurde:

- **Umsetzung** – Specs mit Rails, Loops und Jobs umsetzen.
- **Missionen** – Gespräche mit dem Agenten und Intent-Modus (Missionsrunden, Intent-Runden und die Intent-Neufassung der Spec).
- **Specs** – Specs schreiben und verfeinern: Quick- und Explore-Specs, Verfeinern, Aufteilen, der Spec-Launcher, Vorschläge und Triage.
- **Code** – den Code erklären: Dateizusammenfassungen und Datei-Geschichten.
- **Support** – Einrichtung, Diagnose und Nebenchats: Fehleranalyse, Einrichtung, Agent Studio und die Chat-Seitenleiste.

## Das Dashboard lesen

Die Seite liest sich von oben nach unten als *wie viel → wofür und warum → wann → mit welchen Modellen → die einzelnen Aufrufe*.

### Wie viel (Hero)

Die große Zahl ganz oben sind deine Gesamtausgaben für den gewählten Zeitraum, mit einem **ggü. Vorperiode**-Delta, an dem du auf einen Blick ablesen kannst, ob du im Vergleich zum vorherigen Fenster nach oben oder unten tendierst. Wenn jede Engine über ein Abo läuft, ist die Zahl als *Schätzung als API-Äquivalent* beschriftet: was die Aufrufe zu API-Preisen kosten würden, nicht Geld, das abgebucht wurde. Wenn du ein Projekt gerade erst nutzt, verrät dir der Leerzustand, wann das Tracking begonnen hat.

### Wofür das Geld ausgegeben wurde

Eine Zeile pro Kategorie mit ihren Kosten, ihrem Anteil an der Summe, der Zahl der Aufrufe und Tokens und einer einzeiligen Begründung. Der schraffierte Teil eines Balkens sind geschätzte Kosten (Engines, die ihre Kosten nicht selbst melden). Öffne eine Kategorie, um die Surfaces zu sehen, aus denen sie besteht, und klicke auf eine, um die ganze Seite darauf zu filtern. Die Kategorie Missionen listet außerdem deine teuersten Unterhaltungen.

### Täglicher Verlauf

Ein gestapeltes Balkendiagramm der Ausgaben pro Tag, aufgeschlüsselt nach Surface, mit Missionen in einer eigenen Farbe. Tage ohne Aktivität werden als Null angezeigt und nicht übersprungen. Das ist der schnellste Weg, um zu sehen, *wann* ein teurer Durchlauf stattgefunden hat.

### Budget

Deine Limits für Tag, Woche, Monat und pro Lauf, die Prognose zum Monatsende und die Was-wäre-wenn-Neuberechnung (siehe unten).

### Engines und Modelle

Ausgaben pro Engine (bei Projekten mit mehr als einer) und deine teuersten Modelle nach Ausgaben. Klicke auf ein beliebiges Modell, um das gesamte Dashboard auf genau dieses Modell zu filtern.

### Top-Specs

Deine zehn teuersten Specs über *alle* Surfaces hinweg zusammengefasst, sodass eine Spec, die in Explore wenig und in einem Job viel gekostet hat, ihre wahre Gesamtsumme zeigt. Missionsrunden haben keine Spec und erscheinen hier daher nicht.

### Tabelle der Rohaufrufe

Die nackte Wahrheit: eine Zeile pro Aufruf. Die Spalte **Anlass** zeigt die Surface und ihre Kategorie; Missions- und Intent-Zeilen zeigen die Unterhaltung, zu der sie gehören. Dieser Block hat eigene Sekundärfilter, die nur die Tabelle betreffen.

### Weitere Aufschlüsselungen

Standardmäßig eingeklappt: Zeit bis zur Entscheidung und zum Merge, Loop-Ökonomie, das Streudiagramm Kosten vs. Runden und der Vergleich Quick vs. Explore.

## Filtern

Die fixierte Kopfzeile trägt die Hauptfilter – **Zeitraum**, **Kategorie** und (bei Projekten mit mehreren Engines) **Engine** – und alle werden in der Seiten-URL gespeichert, sodass du eine gefilterte Ansicht („letzte 30 Tage, nur Missionen“) als Lesezeichen speichern oder teilen kannst. Fahre mit der Maus über einen Kategorie-Chip, um zu sehen, was er umfasst. Eine einzelne Surface kannst du in der Karte *Wofür das Geld ausgegeben wurde* auswählen (oder per `?surface=` in der URL); ein entfernbarer Chip in der Kopfzeile zeigt sie an. Die Filter der Rohtabelle sind davon getrennt und bleiben lokal in diesem Block.

Eine Anmerkung zur Genauigkeit: Fehlgeschlagene und abgebrochene Läufe bleiben aus den *Kostendurchschnitten* heraus (sie würden die Werte pro Lauf verzerren), zählen aber weiterhin in deine Gesamtzahl der Läufe und deine Fehlerquote ein. So bleiben die Durchschnitte sauber, während das Bild der Zuverlässigkeit vollständig bleibt.

## Kosten pro Spec

Du musst nicht zur Analytics-Seite kommen, um zu sehen, was eine Spec gekostet hat. Öffne eine beliebige Spec, und wenn ihr Ausgaben zugeordnet sind, siehst du direkt unter dem Titel eine einzeilige Zusammenfassung:

> $0.42 · 6 Runden · 1m 12s aktiv · Aufschlüsselung

Klicke darauf und du landest auf der Analytics-Seite, bereits auf diese Spec gefiltert. Das ist der schnellste Weg von „Was hat mich dieses Feature gekostet?“ zur vollständigen Aufschlüsselung.

## Alle Projekte {#all-projects}

Für das Bild über alle Projekte hinweg öffnest du **Analytics** über die linke Seitenleiste oder die Befehlspalette. Die Seite zeigt Gesamtkosten, Jobs und Erfolgsquote, die Kosten im Zeitverlauf und eine Zeile pro Projekt, und sie nutzt dieselben fünf Kategorien und Farben wie die Projektseite. Missions- und Intent-Runden zählen in jeder Zahl mit. Runden, die zu keinem geladenen Projekt gehören, etwa Missionen auf der Startseite und Blueprint- oder Builder-Chats, sind in einer Zeile **Start & Blueprint** zusammengefasst und werden in Agentenrunden statt in Jobs gezählt. Geschätzte Kosten sind wie auf der Projektseite mit `~` markiert.

## Daten exportieren

Wenn du die Zahlen außerhalb der App brauchst – eine Tabelle, einen Finanzbericht, deine eigene Auswertung – nutze das Dropdown **Export**. Es bietet vier Formate:

- **Zusammenfassung CSV** – eine Datei aus mehreren Abschnitten mit Summen, dem täglichen Verlauf, nach Kategorie, nach Surface, nach Modell und Top-Specs.
- **Zusammenfassung JSON** – dieselbe Zusammenfassung, strukturiert.
- **Rohdaten CSV** – jede Aufrufzeile (bis zu 10.000; es wird vermerkt, falls gekürzt werden musste).
- **Rohdaten JSON** – dieselben Rohzeilen, strukturiert.

Exporte berücksichtigen die aktuell angewendeten Zeitraum-, Kategorie- und Surface-Filter, und die Dateien sind so benannt, dass sie sich sinnvoll sortieren lassen: `<project>-analytics-<period>-<date>.csv`. Die Schaltfläche ist deaktiviert, wenn es nichts zu exportieren gibt, und du erhältst eine klare Fehlermeldung als Toast, falls ein Download fehlschlägt.

## Immer live

Du musst nicht neu laden. Sobald irgendwo im Projekt ein neuer Aufruf erfasst wird, lädt sich das geöffnete Dashboard kurz darauf still neu, sodass der Burn-Meter mit der Arbeit Schritt hält, während sie fertig wird.

## Tagesbudgets {#daily-budget}

Mit einem Tagesbudget begrenzt du, was ein Tag kosten darf. Alle Limits (täglich, wöchentlich, monatlich und pro Lauf) bearbeitest du an einer Stelle: **Analysen → Budget**. **Einstellungen → Erweitert** und **Projekteinstellungen → Budget** zeigen nur das aktuelle Tageslimit, mit einer Schaltfläche **Budget öffnen**, die dorthin führt.

Erreichen die erfassten Tagesausgaben ein Budget, pausiert die Warteschlange sich selbst, Rails und Loop-Läufe starten nicht mehr und melden *Tagesbudget erreicht*, und ein laufender Loop-Lauf hält zwischen zwei Schritten an, pausiert durch das Budget. Erhöhe oder entferne das Budget oder warte auf das tägliche Zurücksetzen und setze dann fort. Ein Loop-Lauf, den nur das Tagesbudget anhält, läuft beim Zurücksetzen des Tages von selbst weiter (um Mitternacht Ortszeit beim Budget eines Projekts, um Mitternacht UTC beim app-weiten), sobald Kapazität frei ist, und vermerkt das in seinem Protokoll; das gilt auch für einen Lauf, der über Mitternacht bei geschlossener App angehalten war: Er läuft beim Start der App weiter. Ein Lauf, den du pausiert hast oder den sein eigenes Limit pro Lauf (oder ein Wochen- oder Monatslimit) noch anhält, wartet weiter auf dich. Abschalten kannst du das unter **Einstellungen → Erweitert → Vom Tageslimit angehaltene Läufe fortsetzen, wenn der Tag zurückgesetzt wird**.

Beide Budgets zählen deinen lokalen Tag, und beide schließen Missionsausgaben ein: Das Budget eines Projekts zählt die an dieses Projekt angehefteten Runden, das app-weite Budget zählt jede Runde. „Heute“ bedeutet überall in der App deinen lokalen Tag, in der Statusleiste, in Analytics und bei den Budgets. Die Kostenwarnung pro Job ist eine eigene Einstellung.

**Wochen-, Monats- und Lauf-Limits.** Längere Limits funktionieren genauso. Unter **Analysen → Budget** legst du ein **Wochen-** und ein **Monatslimit** fest, pro Projekt und für die ganze App, sowie ein **weiches Limit pro Lauf** (*pausieren und nachfragen bei X $*). Wochen beginnen am Montag und Monate am 1., in deiner Ortszeit. Ein Wochen- oder Monatslimit pausiert Warteschlangen, lehnt Starts ab und hält laufende Loops an – genau wie das Tagesbudget; erhöhe oder entferne es dort oder warte auf das Zurücksetzen. Ein begonnener Schritt lässt sich nicht stoppen, deshalb wird das Limit pro Lauf **vor jedem KI-Schritt** geprüft, gemessen an dem, was dieser Schritt üblicherweise kostet: was er früher im selben Lauf gekostet hat, sonst der Median seiner letzten Läufe im Projekt mit demselben Modell, sonst eine Schätzung für einen typischen Schritt dieser Art laut Preisliste. Passt der nächste Schritt nicht mehr hinein, pausiert der Lauf davor und sagt das (*Vor Developer pausiert: Der Schritt kostet meist etwa 0,45 $, vom Limit pro Lauf (0,40 $) sind noch 0,12 $ übrig*); **Fortsetzen** bietet dann an, **nur diesen Schritt auszuführen** (danach gilt das Limit wieder), ohne Limit fortzusetzen oder es zu erhöhen. Ein Lauf, dessen gemeldete Kosten das Limit erreichen, pausiert genauso. Das sind Schätzungen: Ein Schritt, der weit mehr als üblich kostet, kann das Limit trotzdem überschreiten. Jedes erreichte Limit legt außerdem einen Eintrag **Limit erhöhen** im Posteingang an.

Das Budget-Panel zeigt heute, diese Woche und diesen Monat gegenüber jedem Limit. Die **Prognose** zum Monatsende ist eine Schätzung (der Schnitt der letzten 14 vollständigen Tage mal die verbleibenden Tage plus das bisher Ausgegebene) und wird nie zu abgerechneten Ausgaben addiert. **Was wäre, wenn** berechnet die erfassten Token der letzten 30 Tage mit einem anderen Modell neu, anhand der Preisliste der App, und meldet *Kein Preis* für ein Modell ohne Preis. Bei einem Abo gibt es keine Dollarkosten pro Nutzung; das Panel zeigt dann Turns und Abo-Limits statt Dollar.
