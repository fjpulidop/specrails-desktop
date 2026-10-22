# In einem bestehenden Projekt arbeiten

Diese Funktionen helfen Läufen, ein bestehendes Projekt zu respektieren: was eine Spec ausklammert, welche Fragen der Architekt vor der Planung hat, welche Anforderungen ein Test wirklich nachweist, wie alter Code vor einer Änderung beschrieben wird und welche Regeln Ihr Team bereits aufgeschrieben hat. Jede braucht eine specrails-core-Version, die sie unterstützt; bis dahin ist ihr Schalter ausgegraut, mit einem Hinweis, Core zu aktualisieren.

## Nicht im Umfang

Jede Spec kann auflisten, was sie bewusst **nicht** ändert. Quick und Explore füllen das für Sie aus; im Spec-Fenster erscheint es als **Nicht im Umfang** unter der Beschreibung, ein Eintrag pro Zeile, und lässt sich wie jedes andere Feld bearbeiten. Die Agenten erhalten es bei jedem Start mit der Spec.

## Fragen des Architekten in Jira

Aktivieren Sie unter **Einstellungen ▸ Verankerung in bestehenden Projekten** die Option **Klärungsfragen des Architekten in Jira posten**. Wenn ein Lauf anhält, weil der Architekt eine Antwort braucht, oder mit Annahmen fortfährt, postet Specrails sie als einen Kommentar im verknüpften Jira-Issue. Antworten Sie in Jira auf diesen Kommentar: Die Antwort wird der Spec als Klärung hinzugefügt und der nächste Lauf der Spec liest sie. Einen pausierten Lauf können Sie weiterhin in der App beantworten.

## Nachgewiesene Anforderungen

Wenn ein Test die Anforderung nennt, die er nachweist (`[spec:<capability>/<anforderung>]` im Titel), zeigt die Review-Seite **Nachgewiesene Anforderungen X/Y**: welche Anforderungen ein erfolgreicher Test nachweist, welche noch keinen haben und welche die Änderung selbst berührt hat. Die Analysen zeigen dasselbe pro Loop. Damit CI fehlschlägt, wenn eine geänderte Anforderung keinen Test hat, fügen Sie nach Ihren Tests `specrails-core pipeline trace --check --tests-passed` hinzu.

Die Loop-Bibliothek bietet außerdem **Drift-Prüfung**, einen nur lesenden Loop, der vergleicht, was jede Spec sagt und was der Code tut, und jeden Widerspruch auflistet. Er ändert nichts.

## Baseline bei Berührung

Aktivieren Sie **Baseline bei Berührung**, damit eine Änderung, die Code ohne beschreibende Spec erreicht, ihn zuerst beschreibt: Tests des heutigen Verhaltens, am unveränderten Code bestätigt, und eine kurze Spec des Bestehenden. Die Review-Seite zeigt **Spec dort erstellt, wo die Arbeit vorbeikam** mit Modul, Anforderungen und Tests; die Kosten werden getrennt ausgewiesen. Schlagen diese Tests am unveränderten Code fehl, stoppt der Lauf vor jeder Änderung am Modul und sagt das.

## Projektregeln

**Einstellungen ▸ Projektregeln** listet die Prüfungen, die Ihr Projekt bereits ausführt (Lint, Typen, Tests, CI), und jede Regel aus Dateien wie `CLAUDE.md` oder `AGENTS.md`, eingeteilt in:

- **Durchgesetzt**: Eine Prüfung garantiert sie bereits.
- **Automatisierbar**: Eine Prüfung könnte es. **Spec erstellen** macht daraus mit einem Klick eine Spec.
- **Nur menschlich**: Jemand muss hinsehen. Diese Regeln erscheinen auf jeder Review-Seite unter **Braucht menschlichen Blick**.

Regeln, die Core noch nicht einstufen konnte (etwa direkt nach dem Hinzufügen des Projekts, wenn die Inventur offline läuft), erscheinen als **Nicht eingestuft**; **Inventur erneut ausführen** mit konfiguriertem Anbieter stuft sie ein.

**Inventur erneut ausführen** aktualisiert die Liste. Hat ein Projekt noch keine Verifikationsbefehle, bieten die Agent-Runtime-Einstellungen zuerst diese Prüfungen an.
