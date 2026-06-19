# Entwürfe & der Contract Layer

Diese Seite behandelt zwei Wege, mehr aus deinen Specs herauszuholen: **Entwürfe** (eine in Arbeit befindliche Idee speichern, um sie später fortzusetzen) und den **Contract Layer** (eine optionale Anreicherung, die Specs für die KI-Pipeline präziser macht).

## Entwürfe: eine Idee in Arbeit speichern

Ein **Entwurf** ist eine noch in Arbeit befindliche [Explore](add-spec-explore-mode.md)-Unterhaltung, die als Spec gespeichert wurde. Damit kannst du mitten im Gedanken aufhören, ohne etwas zu verlieren, und zurückkommen, wenn du bereit bist.

### Einen Entwurf speichern

Klicke während einer Explore-Unterhaltung auf **Als Entwurf speichern** (verfügbar, sobald du mindestens eine Nachricht gesendet hast). Die App:

- Erstellt eine Spec mit Status **Entwurf** auf deinem Board.
- Vergibt ihr automatisch einen Titel, falls du keinen festgelegt hast (eine kurze Zusammenfassung der Unterhaltung).
- Verknüpft sie zurück mit der Unterhaltung, sodass der vollständige Chatverlauf erhalten bleibt.

Das Speichern ist idempotent – wenn du dieselbe Unterhaltung zweimal speicherst, wird der bestehende Entwurf aktualisiert, statt ein Duplikat anzulegen.

### Wie Entwürfe auf dem Board aussehen

Entwürfe liegen im selben aktiven Bereich wie deine To-do-Specs – es gibt keine eigene Spalte. Du erkennst sie an:

- Einem `Draft`-Pill an der Stelle, wo normalerweise das Prioritäts-Pill sitzt.
- Einem dezent eingefärbten Rand auf der Karte.

Ein Entwurf darf *keine Priorität* haben – die Priorität legst du fest, wenn du ihn in eine echte Spec überführst.

### Einen Entwurf fortsetzen

So machst du dort weiter, wo du aufgehört hast:

1. Öffne den Entwurf vom Board aus.
2. Klicke im Detail-Modal auf **Weiter bearbeiten**.
3. Die ursprüngliche Explore-Unterhaltung öffnet sich erneut mit vollständigem Chatverlauf, und der Live-Entwurfsbereich ist mit allem vorbefüllt, was du bislang geformt hast.
4. Sprich weiter. Wenn du fertig bist, befördert **Spec erstellen** den Entwurf zu einer echten Spec (Status **To-do**, mit der von dir gewählten Priorität).

### Einen Entwurf verwerfen

Entwürfe werden **nie automatisch gelöscht**. Sie verschwinden nur, wenn du sie ausdrücklich verwirfst oder wenn du sie in einen Nicht-Entwurfs-Status überführst. Beim Verwerfen eines Entwurfs wird auch die verknüpfte Unterhaltung aufgeräumt, sofern nichts anderes auf sie verweist.

> Tipp: Wenn du dir nicht sicher bist, ob eine Spec die Mühe wert ist, speichere sie als Entwurf und lass sie liegen. Öffne sie am nächsten Morgen, wirf einen Blick auf die Beschreibung und entscheide mit frischem Blick.

## Der Contract Layer: Präzision für die Pipeline

Der **Contract Layer** ist eine optionale Anreicherung, die der Beschreibung einer Spec einen strukturierten Block anhängt. Seine Aufgabe ist es, den KI-Agenten, die die Spec umsetzen, das Rätselraten zu nehmen – damit sie die richtigen Namen wiederverwenden, die erwarteten Datenformen treffen und die richtigen Dateien anfassen, statt sich eigene auszudenken.

### Was er hinzufügt

Der Contract Layer besteht aus fünf kurzen Abschnitten, die der Spec angehängt werden:

- **Naming Contract** – die genauen Bezeichner (Funktionen, Felder, Routen), die die Implementierung wiederverwenden soll.
- **Data Shapes** – die beteiligten JSON-artigen Payloads.
- **State Machine** – die Übergänge oder Zustände, die das Feature durchläuft.
- **Invariants** – Eigenschaften, die immer gelten müssen.
- **File Touch List** – die Dateien, die die Implementierung voraussichtlich bearbeitet.

Stell es dir so vor, als würdest du der Pipeline eine präzise Bauanleitung statt einer Skizze in die Hand geben. Besonders wertvoll ist das bei Specs, die in bestehenden Code eingreifen, wo ein von der KI geratener Name oder eine geratene Form Nacharbeit verursachen würde.

### Wie du ihn hinzufügst

Es gibt drei Wege, den Contract Layer anzuwenden:

- **Quick-Modus** – leg vor dem Generieren den Schalter **Mit Contract Layer anreichern** um. Deine letzte Wahl wird pro Projekt gemerkt. (Siehe [Spec hinzufügen – Quick-Modus](add-spec-quick-mode.md).)
- **Explore-Modus** – wähle das Kontext-Preset **Max** oder **Desktop** (die die Anreicherung beim Commit automatisch ausführen), oder öffne **Feinabstimmung** und leg ihn von Hand um. (Siehe [Spec hinzufügen – Explore-Modus](add-spec-explore-mode.md).)
- **An einer bestehenden Spec** – öffne das Detail-Modal der Spec und führe die Anreicherung von dort aus erneut aus.

### Wo er auftaucht

Sobald eine Spec einen Contract Layer hat, zeigt ihn das Detail-Modal als einklappbares Element mit einem Badge wie `3/5 befüllt` – das sagt dir, wie viele der fünf Abschnitte tatsächlich befüllt wurden (manche Features haben schlicht zum Beispiel keine State Machine, und solche Abschnitte werden als nicht zutreffend markiert). Klapp es aus, um den vollständigen Contract zu lesen; klapp es ein, um die Beschreibung aufgeräumt zu halten.

Falls die Anreicherung einmal nicht durchläuft, zeigt die App eine Benachrichtigung mit einer Aktion **Wiederholen**, sodass du sie erneut auslösen kannst.

### Lohnt er sich immer?

Nicht immer. Eine kleine, in sich geschlossene Spec kann die KI auch ohne ihn problemlos umsetzen. Der Contract Layer verdient sich seinen Platz bei Specs, die eng mit bestehendem Code verzahnt sind, wo es auf exakte Namen und Formen ankommt – dann erspart dir das frühe Festzurren des Contracts später eine Runde Korrekturen.

## Wie es weitergeht

- [Spec hinzufügen – Explore-Modus](add-spec-explore-mode.md) – woher Entwürfe kommen.
- [Spec hinzufügen – Quick-Modus](add-spec-quick-mode.md) – der Contract-Layer-Schalter im Quick-Modus.
- [Pipelines ausführen](running-pipelines.md) – setze eine Spec um, sobald sie bereit ist.
