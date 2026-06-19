# Spec hinzufügen – Quick-Modus

Der Quick-Modus ist für die Momente gedacht, in denen du bereits weißt, was du willst. Du tippst deine Idee ein, die KI schreibt die vollständige Spec, und sie landet als **To-do** auf deinem Board. Kein Hin und Her – einfach beschreiben und los.

## Eine Spec im Quick-Modus erstellen

So erstellst du schnell eine Spec:

1. Klicke auf dem Dashboard auf **Hinzufügen** (die Plus-Schaltfläche in der SpecsBoard-Toolbar).
2. Wähle den Modus **Quick**.
3. Tippe deine Idee ins Textfeld – ein Satz oder ein Absatz, was immer sie auf den Punkt bringt.
4. Klicke auf Generieren.

Während die Spec geschrieben wird, zeigt ein kleiner Toast in der Ecke den Projektnamen, einen Ausschnitt deiner Idee und die **vergangene Zeit** („Wird generiert… 0:12"). Sobald es fertig ist, wechselt der Toast zu „Generiert in <Zeit>" mit einer Aktion **Anzeigen**, die direkt zu deiner neuen Spec springt.

Das ist der ganze Ablauf. Alles Weitere unten ist optionale Feinjustierung.

## Was du anpassen kannst

**Modell** – standardmäßig wählt die KI ein sinnvolles Modell. Du kannst es pro Spec über die Modellauswahl überschreiben, wenn du ein schnelleres oder leistungsfähigeres möchtest.

**Engine** – wenn in deinem Projekt mehr als ein KI-Provider installiert ist (irgendeine Mischung aus Claude, Codex und Gemini), sitzt oben im Dialog eine Engine-Auswahl, mit der du festlegst, welche diese Spec generiert. Deine Wahl wird pro Projekt gemerkt. Projekte mit nur einem Provider zeigen das nicht – es gibt ja nichts zu wählen.

**Kontext** – der Quick-Modus läuft meist als einzelner Durchgang, weil er deine Codebasis nicht lesen muss, um aus deiner Beschreibung eine Spec zu schreiben. Aber ein Kontext-Schieberegler erlaubt dir, ihm mehr an die Hand zu geben:

- In der niedrigsten Einstellung liest er nur deine Beschreibung.
- In höheren Einstellungen kann er vor dem Schreiben deine vorhandenen Specs, die OpenSpec-Specs deines Projekts und sogar deine gesamte Codebasis lesen.

Je mehr Kontext du ihm gibst, desto länger dauert die Generierung (er wechselt in den Mehrfach-Durchgang, um vorher lesen zu können), dafür kommt die Spec aber fest in deinem tatsächlichen Projekt verankert zurück. Greif zu höherem Kontext, wenn die Spec echten Code, Dateinamen oder bestehendes Verhalten referenzieren muss.

**Anhänge** – zieh Mockups, Briefings oder Datendateien ins Ideenfeld. Die KI liest sie beim Schreiben der Spec mit. (Anhänge schalten die Generierung ebenfalls auf den Mehrfach-Durchgang um.)

**Mit Contract Layer anreichern** – ein Schalter, der der generierten Spec einen strukturierten Block anhängt, damit die nachgelagerte Pipeline keine Namen oder Datenformen raten muss. Er ist optional und standardmäßig aus; deine letzte Wahl wird pro Projekt gemerkt. Was er hinzufügt und wann er sich lohnt, liest du unter [Entwürfe & der Contract Layer](drafts-and-contract-layer.md).

## Wann Quick-Modus, wann Explore

Nutze **Quick**, wenn die Idee in deinem Kopf schon klar ist – du könntest die Spec selbst schreiben, du lässt sie nur lieber von der KI verfassen. Nutze [**Explore**](add-spec-explore-mode.md), wenn du sie noch durchdenkst und einen Partner möchtest, der dir beim Formen hilft.

Eine im Quick-Modus erstellte Spec ist eine ganz normale Spec: Du kannst sie später öffnen und in einer Explore-Session **weiter bearbeiten**, falls sie noch Feinschliff braucht.

## Wie es weitergeht

- [Spec hinzufügen – Explore-Modus](add-spec-explore-mode.md) – für Specs, die noch geformt werden müssen.
- [Entwürfe & der Contract Layer](drafts-and-contract-layer.md) – die Contract-Layer-Anreicherung erklärt.
- [Pipelines ausführen](running-pipelines.md) – zieh deine neue Spec auf eine Rail und setze sie um.
