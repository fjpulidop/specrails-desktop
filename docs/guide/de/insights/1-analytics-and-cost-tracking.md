# Analytics & Kostenverfolgung

Jedes Mal, wenn Specrails in deinem Auftrag eine KI-CLI ausführt – einen Pipeline-Job, eine Quick-Spec, eine Explore-Sitzung, eine KI-Bearbeitung, eine Dateizusammenfassung – wird festgehalten, was passiert ist: welches Modell gelaufen ist, wie viele Tokens hinein- und hinausgingen, wie lange es gedauert hat und was es gekostet hat. Der Bereich **Analytics** verwandelt all das in ein einziges Dashboard, damit du immer weißt, wohin deine KI-Ausgaben fließen.

Du öffnest ihn über die rechte Seitenleiste (Beschriftung **Analytics**). Alles, was du siehst, bezieht sich auf das Projekt, in dem du dich gerade befindest – wechselst du das Projekt, ziehen die Zahlen mit.

## Was als Ausgabe zählt

Specrails versieht jeden KI-Lauf mit einer *Surface*: dem Teil der App, der die Ausgabe verursacht hat. Die wichtigsten Surfaces haben jeweils eine feste Farbe und einen eigenen Filter-Chip, sodass du sie auf einen Blick erkennst:

- **Job** – ein in der Queue eingereihter Pipeline-Job (Architect → Developer → Reviewer → Ship), einschließlich Freestyle-Läufen.
- **Loop** – jeder KI-Schritt eines Loop-Laufs. Rails laufen standardmäßig als Loops, daher landet der Großteil der Rail-Ausgaben hier.
- **Quick-Spec** – eine Spec, die über den schnellen „Spec hinzufügen“-Weg erzeugt wurde.
- **Explore-Spec** – eine Explore-Unterhaltung, in der du eine Spec im Gespräch formst.
- **KI-Bearbeitung** – eine KI-gestützte Verfeinerung an einem Agenten oder einer Datei.
- **SMASH** – das Aufteilen einer Epic-Spec in kleinere Specs.
- **Dateizusammenfassung** – die verständlichen Zusammenfassungen und Datei-Geschichten, die den Code-Explorer speisen.

Kleinere Surfaces werden ebenfalls erfasst, nur ohne eigenen Chip: die Chat-Seitenleiste, der OpenSpec-Spec-Launcher, Spec-Vorschläge, Agent Studio und der ältere Einrichtungs-Chat. Auch an das Projekt angeheftete Missionen zählen zu seinen Ausgaben. Nichts, was eine KI-CLI ausführt, bleibt außen vor – die Summen spiegeln also die gesamte KI-Aktivität des Projekts wider.

## Das Dashboard lesen

Die Seite besteht aus einer Handvoll Blöcke, von oben nach unten:

### Der Burn-Meter (Hero)

Die große Zahl ganz oben sind deine Gesamtausgaben für den gewählten Zeitraum, mit einem **ggü. Vorperiode**-Delta, an dem du auf einen Blick ablesen kannst, ob du im Vergleich zum vorherigen Fenster nach oben oder unten tendierst. Wenn du ein Projekt gerade erst nutzt, verrät dir der Leerzustand, wann das Tracking begonnen hat („Tracking gestartet am JJJJ-MM-TT“) – es gibt keine rückwirkende Erfassung, der Meter kennt also nur Läufe, die während dieser Version stattgefunden haben.

### Täglicher Verlauf

Ein gestapeltes Balkendiagramm der Ausgaben pro Tag, aufgeschlüsselt nach Surface. Tage ohne Aktivität werden als Null angezeigt und nicht übersprungen, damit das Bild deiner Woche ehrlich bleibt. Das ist der schnellste Weg, um zu sehen, *wann* ein teurer Durchlauf stattgefunden hat.

### Quick vs. Explore

Eine Vergleichskarte, die deine beiden Stile der Spec-Erstellung nebeneinanderstellt. Wenn du weniger als fünf Explore-Sitzungen durchgeführt hast, zeigt sie statt irreführender Durchschnittswerte einen sanften Handlungshinweis – kleine Stichproben taugen nicht für verlässliche Vergleiche.

### Nach Modell

Deine teuersten Modelle nach Ausgaben (bis zu zehn). Klicke auf ein beliebiges Modell, um das gesamte Dashboard auf genau dieses Modell zu filtern – praktisch, wenn du wissen willst, was ein bestimmtes High-End-Modell wirklich kostet.

### Streudiagramm Kosten vs. Runden

Jeder Punkt steht für einen Aufruf und trägt die Kosten gegen die Anzahl der Runden auf. Ausreißer – die teuren Läufe mit vielen Runden – springen sofort ins Auge. (Das Streudiagramm zeigt deine 500 jüngsten Punkte, damit es reaktionsschnell bleibt.)

### Top-Tickets

Deine zehn teuersten Tickets über *alle* Surfaces hinweg zusammengefasst, sodass ein Ticket, das in Explore wenig und in einem Job viel gekostet hat, seine wahre Gesamtsumme zeigt. Gelöschte Tickets und nicht zugeordnete Läufe bekommen eigene Sammelposten, damit nichts stillschweigend aus den Summen verschwindet.

### Tabelle der Rohaufrufe

Die nackte Wahrheit: eine Zeile pro Aufruf. Dieser Block hat eigene Sekundärfilter, die nur die Tabelle betreffen, sodass du ins Detail gehen kannst, ohne die Diagramme darüber zu stören.

## Filtern

Die fixierte Kopfzeile ganz oben trägt die beiden Hauptfilter – **Zeitraum** und **Surface** – und beide werden in der Seiten-URL gespeichert. Das heißt, du kannst eine gefilterte Ansicht („letzte 30 Tage, nur Jobs“) als Lesezeichen speichern oder teilen, und sie öffnet sich wieder genau so, wie du sie verlassen hast. Die Filter der Rohtabelle sind davon getrennt und bleiben lokal in diesem Block.

Eine Anmerkung zur Genauigkeit: Fehlgeschlagene und abgebrochene Läufe bleiben aus den *Kostendurchschnitten* heraus (sie würden die Werte pro Lauf verzerren), zählen aber weiterhin in deine Gesamtzahl der Läufe und deine Fehlerquote ein. So bleiben die Durchschnitte sauber, während das Bild der Zuverlässigkeit vollständig bleibt.

## Kosten pro Ticket

Du musst nicht zur Analytics-Seite kommen, um zu sehen, was eine Spec gekostet hat. Öffne ein beliebiges Ticket, und wenn ihm Ausgaben zugeordnet sind, siehst du direkt unter dem Titel eine einzeilige Zusammenfassung:

> $0.42 · 6 Runden · 1m 12s aktiv · Aufschlüsselung

Klicke darauf und du landest auf der Analytics-Seite, bereits auf dieses Ticket gefiltert. Das ist der schnellste Weg von „Was hat mich dieses Feature gekostet?“ zur vollständigen Aufschlüsselung.

## Daten exportieren

Wenn du die Zahlen außerhalb der App brauchst – eine Tabelle, einen Finanzbericht, deine eigene Auswertung – nutze das Dropdown **Export**. Es bietet vier Formate:

- **Zusammenfassung CSV** – eine Datei aus mehreren Abschnitten mit Summen, dem täglichen Verlauf, nach Surface, nach Modell und Top-Tickets.
- **Zusammenfassung JSON** – dieselbe Zusammenfassung, strukturiert.
- **Rohdaten CSV** – jede Aufrufzeile (bis zu 10.000; es wird vermerkt, falls gekürzt werden musste).
- **Rohdaten JSON** – dieselben Rohzeilen, strukturiert.

Exporte berücksichtigen die aktuell angewendeten Zeitraum- und Surface-Filter, und die Dateien sind so benannt, dass sie sich sinnvoll sortieren lassen: `<project>-analytics-<period>-<date>.csv`. Die Schaltfläche ist deaktiviert, wenn es nichts zu exportieren gibt, und du erhältst eine klare Fehlermeldung als Toast, falls ein Download fehlschlägt.

## Immer live

Du musst nicht neu laden. Sobald irgendwo im Projekt ein neuer Aufruf erfasst wird, lädt sich das geöffnete Dashboard kurz darauf still neu, sodass der Burn-Meter mit der Arbeit Schritt hält, während sie fertig wird.

## Tagesbudgets {#daily-budget}

Mit einem Tagesbudget begrenzt du, was ein Tag kosten darf. Das app-weite Budget findest du unter **Einstellungen → Erweitert**, das Projektbudget unter **Projekteinstellungen → Budget**.

Erreichen die erfassten Tagesausgaben ein Budget, pausiert die Warteschlange sich selbst, Rails und Loop-Läufe starten nicht mehr und melden *Tagesbudget erreicht*, und ein laufender Loop-Lauf hält zwischen zwei Schritten an, pausiert durch das Budget. Erhöhe oder entferne das Budget oder warte auf das tägliche Zurücksetzen und setze dann fort.

Das Projektbudget zählt deinen lokalen Tag, das app-weite Budget den UTC-Tag. Die Kostenwarnung pro Job ist eine eigene Einstellung.
