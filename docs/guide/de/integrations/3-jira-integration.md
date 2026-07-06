# Jira-Integration

Du möchtest, dass deine Specs auf einem echten **Jira-Board** leben statt in Specrails? Die Jira-Integration hinterlegt die Specs eines Projekts mit Jira-Vorgängen, hält die Status synchron, während Rails laufen, und hält sich die übrige Zeit zurück. Jedes Projekt synchronisiert sich mit **seinem eigenen** Jira-Board.

## So funktioniert es (die Kurzfassung)

Specrails agiert als **Sync-Schicht** zwischen Jira und deinem Projekt. Die Grundidee: Dein lokaler Spec-Speicher bleibt das Maßgebliche, das die Pipeline liest, und Specrails ist dafür verantwortlich, ihn und Jira in Übereinstimmung zu halten.

- Wenn du eine Rail startest, verschiebt Specrails den verknüpften Jira-Vorgang nach **In Arbeit**.
- Wenn ein Job abschließt, überführt Specrails den Vorgang: bei Erfolg in deinen gemappten **Prüf**-Status — **Fertig** wird er erst, wenn die Liefer-PR gemerged oder das lokale Ergebnis akzeptiert wurde; bei Fehlschlag zurück nach **To Do** mit einem Abschlusskommentar, der Ergebnis, Run-ID, Kosten, Dauer und die Jira-Statusänderung enthält.
- Wenn du Follow-up-Änderungen anfragst, während der Jira-Vorgang bereits in Prüfung ist, versucht Specrails, die bestehende offene PR-Branch für dieses Ticket fortzusetzen, statt eine neue Branch zu erstellen. Falls dein Jira-Prüfstatus nicht explizit gemappt ist und lokal noch als **In Arbeit** erscheint, kann Specrails die PR trotzdem fortsetzen, wenn der Jira-Schlüssel zum offenen Pull-Request passt.
- In regelmäßigen Abständen **pollt** Specrails Jira nach Änderungen, die jemand auf dem Board vorgenommen hat, und spiegelt sie zurück in deine Specs.

Alle Rückschreibungen laufen über eine dauerhafte, absturzsichere Outbox, sodass ein kurzzeitiger Jira-Aussetzer niemals einen Job kaputtmacht — das Update wird einfach erneut versucht.

## Ein Board verbinden

Du verbindest dich über die **Einstellungen**-Seite eines Projekts (am Ende des „Projekt hinzufügen“-Assistenten gibt es zusätzlich einen optionalen Schritt „Jira konfigurieren“). Der Verbindungsassistent führt dich durch:

1. **Testen** — gib deine Jira-URL und deine Zugangsdaten ein, und Specrails überprüft die Verbindung.
2. **Projekt wählen** — wähle aus, mit welchem Jira-Projekt synchronisiert werden soll.
3. **Statuszuordnung (optional)** — ordne deine Jira-Workflow-Status den Zuständen von Specrails zu, falls die automatische Erkennung etwas Hilfe braucht (mehr dazu unten).
4. **Verbinden** — fertig. Deine Specs spiegeln nun dieses Board.

### Authentifizierung

Diese Version nutzt **Token-Einfügen** zur Authentifizierung — schnell, lokal auf dem Gerät und ganz ohne Backend:

- **Jira Cloud:** deine Konto-E-Mail plus ein API-Token.
- **Jira Data Center / Server:** ein Personal Access Token (PAT).

Dein Token wird **verschlüsselt auf deinem eigenen Rechner** gespeichert und verlässt ihn nie. Die App zeigt nur an, ob ein Token vorhanden ist, niemals das Token selbst.

## Statuszuordnung

Der kniffligste Teil jeder Jira-Synchronisierung ist es, *deinen* Workflow auf die einfachen Zustände von Specrails abzubilden (To Do / In Arbeit / In Prüfung / Fertig, plus Abbruch-Varianten). Specrails löst das in zwei Stufen:

1. **Deine explizite Statuszuordnung**, falls du im Assistenten eine festgelegt hast — sie gewinnt immer.
2. **Automatische Erkennung** anhand der Kategorie jedes Status (new / in-progress / done) plus intelligentem Abgleich für Abbruch- und Ship-artige Status.

Muss ein Vorgang über einen Workflow mit gesteuerten Übergängen bewegt werden, findet Specrails Schritt für Schritt einen gültigen Pfad und füllt unterwegs alle erforderlichen Felder aus (etwa eine Resolution). Lässt sich ein Status wirklich nicht erreichen, wird die Operation als Dead-Letter geparkt und dir angezeigt, statt still fehlzuschlagen — du siehst dann einen **Beeinträchtigt**-Hinweis und kannst es erneut versuchen.

## Hot-Swap: sicher ein- und ausschalten

Die Jira-Verknüpfung ist **pro Spec**, festgehalten in dem Moment, in dem du eine Rail startest — kein globaler Alles-oder-nichts-Schalter für das Board. Das macht das Umschalten sicher:

- **Aktivieren oder Deaktivieren** der Integration ordnet deine bestehenden Specs nie neu zu.
- **Trennen** versetzt dein Projekt zurück in das normale Verhalten mit lokalen Specs.
- Specs, die bereits eine Jira-Verknüpfung haben, behalten ihre Rückschreibung; Specs ohne werden in Ruhe gelassen.

So kannst du frei experimentieren — anschalten, ein paar Rails laufen lassen, ausschalten — ohne dein Board oder deine lokalen Specs durcheinanderzubringen.

## Im Alltag

Nach dem Verbinden zeigt die Einstellungen-Seite des Projekts eine **Verbunden-Karte**, auf der du:

- **Jetzt synchronisieren** — ein sofortiges Pollen erzwingen, statt auf den Timer zu warten.
- **Dead-Letter erneut versuchen** — alle hängengebliebenen Rückschreibungen erneut ausführen.
- **Hot-Swap-Schalter** — die Integration vorübergehend pausieren/fortsetzen.
- **Trennen** — das Board sauber lösen.

Specs, die mit Jira hinterlegt sind, zeigen ein **Jira-Schlüssel-Badge** (etwa `PROJ-123`) auf ihrer Karte, und ein Klick darauf führt zurück zum Vorgang. Außerdem bekommst du kleine Benachrichtigungen, wenn eine Synchronisierung abschließt, wenn ein Auth-Token abläuft (damit du es erneuern kannst) oder wenn die Integration in einen beeinträchtigten Zustand gerät.

## Was du im Hinterkopf behalten solltest

- **Polling statt Webhooks.** Da Specrails lokal läuft, pollt es Jira nach eingehenden Änderungen, statt Push-Benachrichtigungen zu empfangen. Änderungen erscheinen innerhalb des Poll-Intervalls, nicht sofort.
- **Ein Board pro Projekt.** Verschiedene Projekte können sich mit verschiedenen Boards synchronisieren; ein einzelnes Projekt synchronisiert sich mit genau einem.
- **Last-Write-Wins bei Konflikten** für den seltenen Fall, dass zwei Tabs denselben Entwurf gleichzeitig bearbeiten.

## Ausschalten

Wenn du jemals vollständig aussteigen möchtest, **trenne** einfach in den Einstellungen. Deine Specs kehren zum reinen Lokal-Verhalten zurück, und die Jira-Metadaten liegen einfach ungenutzt herum — es wird nichts zerstört.
