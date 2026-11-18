<!-- guide-revision: mission-first-v1 -->

# Einen Anbieter und seine Fähigkeiten wählen {#provider-capabilities}

Ausführungseinstellungen gehören zum gewählten Anbieter. Ein vertrauter Modellname bedeutet nicht, dass jeder Anbieter dieselben Reasoning-, Strukturausgabe- oder Freigabe-Einstellungen unterstützt.

## Zuerst die Verfügbarkeit prüfen

Melde das CLI des Anbieters an und bestätige seinen Status in Specrails. Wähle unter den Modellen und Aufwandswerten, die die Steuerelemente dieses Anbieters anbieten. Ein installiertes CLI kann trotzdem scheitern, weil seine Sitzung, sein Kontingent oder sein Remote-Dienst nicht verfügbar ist.

Claude und Codex haben unterschiedliche Adapter. Nicht unterstützte Kombinationen sollten scheitern, bevor ein Loop startet; zum Beispiel kann man nicht davon ausgehen, dass ein Schritt, der eine strukturierte Antwort ohne Tools verlangt, mit jedem Anbieter funktioniert.

## Die richtige Steuerungsebene nutzen

Die Anbieter-/Modellwahl eines Rails steuert seine Ausführung. Der Freestyle-Loop aus der Galerie läuft mit jedem CLI-Anbieter und jeder lokalen Engine; nur Claude bietet zusätzlich den interaktiven Chat im Job. Rollenprofile und das Routing pro Agent hängen vom Anbieter und vom Core-Workflow ab, den Desktop im Projekt installiert hat; prüfe die tatsächlich wirksame Konfiguration, statt anzunehmen, dass ein Profil jeden Aufruf ändert.

Halte beim Vergleichen von Läufen dieselbe Spec, dieselbe Repository-Revision und dieselben Prüfkriterien bei. Behandle gemeldete, geschätzte und nicht verfügbare Kosten getrennt. Siehe [Profile](../agents/profiles-and-the-balanced-default) und [Nutzung](../insights/analytics-and-cost-tracking).

Bei einem Missionsstart übernehmen Loop-Schritte Anbieter, Modell und Aufwand der Mission, sofern ein Agent sie nicht ausdrücklich im Loop-Editor überschreibt. Die allgemeinen Einstellungen verwalten die Anbieterverbindungen; der frühere Block mit Anbieter-Standards und die Rollenauswahl werden nicht mehr angeboten.
