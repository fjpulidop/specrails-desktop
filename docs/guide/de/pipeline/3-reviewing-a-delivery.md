<!-- guide-revision: mission-first-v1 -->

# Eine Lieferung in der App prüfen {#review-a-delivery}

Eine prüfbereite Lieferung hat zwei Ansichten: **Übersicht** (das Urteil, die Belege und die Entscheidungsschaltflächen) und **Änderungen** (was die Lieferung tatsächlich geändert hat). Öffne die Prüfung über die Schaltfläche **Prüfen** der Lieferung und wähle dann **Änderungen**.

## Die Änderungen lesen

Die Dateiliste links zeigt jede geänderte Datei mit Status (hinzugefügt, geändert, gelöscht, umbenannt), ihren `+`- und `−`-Zeilenzahlen und einem Haken, sobald du sie als angesehen markierst. Der Diff rechts lädt jeweils eine Datei, daher bleibt auch eine große Änderung flüssig. Wechsle zwischen den Darstellungen **Vereint** und **Geteilt**; Specrails merkt sich deine Wahl. Eine sehr große Datei zeigt ihre ersten Zeilen mit **Vollständigen Datei-Diff laden**; eine Binärdatei wird als binär aufgeführt.

Die Änderungen werden ab dem Punkt gemessen, an dem die Lieferung von ihrem Basis-Branch abzweigte, daher erscheint nichts, was danach in die Basis kam. Hat eine Lieferung noch keinen kombinierten Branch, kannst du wählen, den Branch welcher Spec du lesen willst.

## Anmerkungen des Reviewers am Code

Die Befunde des Reviewers, die markierten Risiken und die Review-Kommentare, die der Lauf lösen sollte, erscheinen unter der Zeile, um die es geht. Anmerkungen ohne Datei oder Zeile stehen über der Dateiliste, es wird also nichts verborgen. Ältere Lieferungen und Reviewer, die keinen Ort nannten, zeigen ihre Befunde in dieser Liste.

## Den Agenten um eine Änderung bitten

Wähle Zeilen per Klick auf ihre Nummern (Umschalt-Klick erweitert den Bereich), wähle **Änderung beim Agenten anfragen** und beschreibe die Änderung. Specrails speichert sie als Review-Feedback an der Spec, mit Datei, Zeilenbereich und dem ausgewählten Code, und zeigt eine Meldung mit einem Link zur Spec. Der nächste Lauf zu dieser Spec erhält es. Um ihn sofort zu starten, nutze **Änderungen anfordern** in der Übersicht. Hier gibt es keine Kommentarthreads zwischen Personen; besprich dich mit deinem Team auf GitHub.

## In deinem Editor öffnen

**Im Editor öffnen** öffnet die Datei an der ausgewählten Zeile in VS Code, Cursor oder einer JetBrains-IDE. Den Editor wählst du unter **Einstellungen → Code → Editor**. Die Datei öffnet sich aus deinem eigenen Checkout des Projekts, in dem der Review-Branch möglicherweise nicht ausgecheckt ist.

## Entscheiden, was mit einer Lieferung geschieht {#pr-decision}

Ein abgeschlossener Lauf fragt dich nur eines: Was soll mit dem Ergebnis passieren? Die Karte zeigt eine Hauptschaltfläche für den nächsten Schritt (PR erstellen, veröffentlichen oder prüfen) und daneben **Prüfen**, das das verständliche Review-Paket öffnet. Alles andere liegt hinter **Weitere Aktionen**:

- **Branch auschecken** legt den Branch in deinem Projektordner ab, damit du ihn ausprobieren kannst.
- **Lokal integrieren** führt das Ergebnis auf diesem Computer in deinen Basis-Branch zusammen. GitHub ist nicht nötig, und du bestätigst vorher.
- **Verwerfen** entfernt das Ergebnis und seinen Branch. Du bestätigst vorher.

Schlägt eine Aktion fehl, nennt die Meldung, was nicht geklappt hat, und bietet **Wiederholen** an.

## Tastatur

| Taste | Aktion |
| --- | --- |
| `j` / `k` | Nächste / vorherige geänderte Datei |
| `n` / `p` | Nächste / vorherige Anmerkung des Reviewers |
| `v` | Datei als angesehen markieren |

Die Tasten werden ignoriert, während du in ein Feld tippst. „Angesehen“ ist nur für dich sichtbar; ändert sich die Datei in einer späteren Revision, zeigt sie **Seit dem Ansehen geändert** und gilt wieder als nicht angesehen.
