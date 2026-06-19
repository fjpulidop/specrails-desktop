# Spec hinzufügen – Explore-Modus

Der Explore-Modus ist eine Unterhaltung. Statt die Spec selbst zu schreiben, durchdenkst du die Idee gemeinsam mit der KI – sie agiert als Denkpartner, stellt Fragen, schlägt eine Struktur vor und baut dabei einen **Live-Entwurf** der Spec auf. Wenn du zufrieden bist, überführst du den Entwurf in eine echte Spec.

Greif zu Explore, wenn die Idee noch nicht ganz ausgereift ist, wenn es Abwägungen zu besprechen gibt oder wenn du möchtest, dass die KI sich deinen tatsächlichen Code ansieht, bevor die Spec festgezurrt wird.

## Eine Spec im Explore-Modus erstellen

So formst du eine Spec im Explore-Modus:

1. Klicke auf dem Dashboard auf **Hinzufügen** und wähle dann **Explore**.
2. Tippe deine erste Nachricht – die Idee, eine Frage oder einen halbgaren Gedanken.
3. Lies die Antwort der KI und antworte weiter. Mit jedem Zug verfeinert sie ihr Verständnis.
4. Beobachte, wie sich der **Live-Entwurf** neben dem Chat aktualisiert – das ist die Spec, die Gestalt annimmt.
5. Wenn der Entwurf passt, klicke auf **Spec erstellen**.

Die Unterhaltung bleibt in deinem Verlauf, sodass du jederzeit zurückkommen kannst, um zu sehen, wie die Spec entstanden ist.

## Der Live-Entwurf

Während du dich unterhältst, zeigt ein Entwurfsbereich die Spec in ihrem aktuellen Stand – Titel, Beschreibung, Priorität, Labels, Akzeptanzkriterien. Sie schreibt sich mit jedem Zug auf Basis des Besprochenen neu. Du bearbeitest sie nicht direkt; du steuerst sie über die Unterhaltung („mach die Priorität doch hoch", „füge ein Kriterium zur Fehlerbehandlung hinzu" und so weiter).

Das ist das Herzstück des Explore-Modus: Du starrst nie auf ein leeres Formular. Du blickst immer auf eine echte, sich entwickelnde Spec.

## Wie viel die KI sieht: der Kontext-Schieberegler

Bevor die KI antwortet, entscheidest du, wie viel von deinem Projekt sie sehen darf. Ein Schieberegler mit Kontext-Presets lässt dich Geschwindigkeit gegen Tiefe abwägen:

| Preset | Was die KI sieht |
|--------|------------------|
| **Minimal** | Nur deine Nachricht. Am schnellsten und günstigsten. |
| **Leicht** | + deine vorhandenen Specs. |
| **Standard** | + deine Specs und die OpenSpec-Specs deines Projekts. |
| **Umfangreich** | + Lesezugriff auf deine gesamte Codebasis, damit sie Antworten in echtem Code verankern kann. |
| **Max** | Umfangreich, plus ein Contract-Layer-Anreicherungsdurchgang beim Commit. |
| **Desktop** | Max, plus die MCP-Server deines Projekts und deine eigenen freigegebenen MCP-Server. |

Starte niedrig für schnelles Brainstorming; geh höher, wenn du möchtest, dass die KI ihre Vorschläge gegen deinen tatsächlichen Code prüft. Die Wahl wird an der Unterhaltung gespeichert, sie schwappt also nicht in andere Explore-Sessions über.

Wenn du feinere Kontrolle möchtest, klicke auf **Feinabstimmung**, um die zugrunde liegenden Optionen von Hand umzulegen – darunter **Meine freigegebenen MCPs**, das die MCP-Server lädt, die du lokal bereits freigegeben hast, ohne die Session zu verlangsamen.

## Schaltflächen in der Explore-Oberfläche

- **Spec erstellen** – befördert den Live-Entwurf zu einer echten Spec mit Status **To-do**. (Wenn du eine bestehende Spec bearbeitest, heißt diese Schaltfläche stattdessen **Spec aktualisieren** und patcht die Spec an Ort und Stelle.)
- **Prüfen →** – öffnet ein Prüf-Overlay, das die vorgeschlagene Spec vor dem Commit gegen die Ausgangsbasis abgleicht, damit es keine Überraschungen gibt.
- **Als Entwurf speichern** – speichert die Unterhaltung als Entwurfsticket, damit du sie später aufgreifen kannst. Verfügbar, sobald du mindestens eine Nachricht gesendet hast. Siehe unten.
- **Minimieren** – parkt die Unterhaltung als Chip im Dock der minimierten Chats unten links. Klicke jederzeit auf den Chip, um direkt in die Unterhaltung zurückzuspringen – nichts geht verloren.
- **Verwerfen** – wirft die Unterhaltung weg (fragt vorher nach Bestätigung).

## Als Entwurf speichern

Noch nicht bereit zum Committen, aber du willst die Überlegungen nicht verlieren? Klicke auf **Als Entwurf speichern**. Die Unterhaltung wird zu einer **Entwurfs-Spec** auf deinem Board, und der Entwurf bleibt mit der dahinterliegenden Unterhaltung verknüpft.

Öffne den Entwurf später vom Board aus und klicke auf **Weiter bearbeiten** – die ursprüngliche Unterhaltung öffnet sich erneut mit vollständig erhaltenem Chatverlauf, und du machst genau dort weiter, wo du aufgehört hast. Entwürfe werden nie automatisch gelöscht; sie warten auf dich.

Damit lässt sich Explore unbesorgt für halbgare Ideen nutzen: starte eine Unterhaltung, komm ein Stück weit, speichere sie als Entwurf und komm morgen zurück.

Alles rund um Entwürfe – inklusive der Contract-Layer-Anreicherung – findest du unter [Entwürfe & der Contract Layer](drafts-and-contract-layer.md).

## Hinweis zu mehreren Providern

Wenn in deinem Projekt mehr als ein KI-Provider installiert ist, lässt dich eine Engine-Auswahl bestimmen, welche die Explore-Unterhaltung antreibt. Projekte mit nur einem Provider zeigen sie nicht.

## Wie es weitergeht

- [Entwürfe & der Contract Layer](drafts-and-contract-layer.md) – Arbeit zwischenspeichern und Specs für die Pipeline anreichern.
- [Spec hinzufügen – Quick-Modus](add-spec-quick-mode.md) – wenn die Idee schon klar ist.
- [Pipelines ausführen](running-pipelines.md) – setze deine Spec um, sobald sie bereit ist.
