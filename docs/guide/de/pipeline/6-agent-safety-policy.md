# Sicherheitsrichtlinie für Agenten {#agent-safety-policy}

Agenten in Rails, Loops und Missionen arbeiten, ohne dich vor jedem Befehl zu fragen. Das hält sie schnell, aber einige Aktionen sind zu riskant, um sie dem Agenten zu überlassen. Specrails prüft jeden Werkzeugaufruf eines **Claude**-Agenten vor der Ausführung gegen eine kurze Sperrliste und blockiert die Einträge darauf.

## Was blockiert wird und warum

| Blockiert | Warum |
|---|---|
| **Force-Push** (`--force`, `--force-with-lease`, `+branch`, `--mirror`) | Er schreibt gemeinsame Historie um. |
| **Push auf den Integrationsbranch** (Standardbranch des Projekts, `main` oder `master`) | Arbeit kommt dort nur über einen Pull Request an, den eine Person mergt. |
| **Löschen eines Remote-Branches** | Branches werden mit der Auslieferung aufgeräumt, nicht vom Agenten. |
| **`git reset --hard` außerhalb des Run-Branches** | Auf dem Run-Branch im Run erlaubt; anderswo kann es fremde Arbeit zerstören. |
| **Löschen von Branches**, die geschützt sind, dem Run selbst gehören oder außerhalb des Runs liegen | Aus demselben Grund. |
| **Mergen eines Pull Requests** (`gh pr merge`) | Was gemergt wird, entscheidest du. |
| **Rekursives Löschen außerhalb des Runs** (`rm -rf`, `rimraf`, `find -delete`, `git clean -f`) | Nur der Worktree des Runs und temporäre Ordner dürfen geleert werden. Auch ein Löschen mit unbekanntem Ziel (`rm -rf "$DIR"`, `xargs rm -rf`) wird blockiert. |
| **Lesen oder Schreiben von Zugangsdaten**: `~/.ssh`, `~/.aws`, `~/.gnupg`, Schlüsselbunde und der Specrails-Geheimnisspeicher | Agenten brauchen deine Schlüssel nie. |
| **Ändern der Dateien der Richtlinie selbst** | Damit ein Agent sie nicht abschalten kann. |

Alles andere läuft wie bisher.

## Was du siehst

- Der Agent erhält den Grund und macht ohne diese Aktion weiter oder erklärt, was er braucht.
- Das Run-Log oder die Mission zeigt eine Zeile **Von der Specrails-Richtlinie blockiert** mit Regel und Grund.
- Das [Audit der Agentenaktionen](3-reviewing-a-delivery.md) erfasst jede Sperre (Quelle `policy-hook`) neben der versuchten Aktion.

## Wo sie gilt

- Isolierte Rails, Loops und Intent-Sitzungen (jeweils in einem eigenen Worktree) und Missionen.
- **Nur Claude.** Für Codex gibt es nichts Gleichwertiges, das Specrails installieren kann, ohne deine eigene Codex-Konfiguration zu ändern; bei Codex-Runs prüft Specrails weiterhin Branch und Auslieferung nach jedem Schritt.
- Runs, die direkt in deinem Projektordner arbeiten (nicht isoliert), sind nicht abgedeckt: Specrails schreibt nie in deinen eigenen Checkout.
- macOS und Linux. Unter Windows wird die Richtlinie noch nicht installiert.

## Gut zu wissen

- Das ist ein Geländer, keine Sandbox. Es stoppt die üblichen zerstörerischen Befehle; einen feindseligen Agenten macht es nicht sicher.
- Schlägt die Prüfung selbst fehl, läuft der Aufruf weiter, außer er sieht nach einem Eintrag der Sperrliste aus: dann wird er blockiert. Eine defekte Prüfung hält nie alle Agenten an.
- Zum Abschalten im Notfall Specrails mit `SPECRAILS_AGENT_POLICY_HOOK=false` starten.
