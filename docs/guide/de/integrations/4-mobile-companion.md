# Der mobile Companion

Specrails hat eine Companion-App fürs Smartphone, mit der du deine Rails im Blick behältst, während du nicht am Schreibtisch sitzt — Jobs laufen sehen, ihren Abschluss verfolgen und auf dem Laufenden bleiben, ohne vor dem Dashboard zu sitzen.

## Wofür sie da ist

Der Companion ist eine **Monitoring**-Oberfläche. Er verbindet sich über dein lokales Netzwerk mit deiner laufenden Specrails-Desktop-App und spiegelt die Live-Aktivität von Projekten und Jobs auf dein Smartphone. Stell ihn dir als ein Fenster auf einen Blick zu denselben Rails vor, die du sonst auf dem Dashboard beobachten würdest.

## Dein Smartphone koppeln

Das Koppeln baut auf einem **QR-Code** auf, damit du nichts Umständliches eintippen musst:

1. Stelle sicher, dass deine Specrails-Desktop-App läuft und dein Smartphone im **selben lokalen Netzwerk** ist (gleiches WLAN).
2. Öffne in der Desktop-App den Kopplungsbildschirm, um einen QR-Code anzuzeigen.
3. Scanne diesen Code in der Companion-App auf deinem Smartphone.
4. Das Smartphone entdeckt die Desktop-App im Netzwerk und verbindet sich.

Von da an hält der Companion eine Live-Verbindung und streamt Projektlisten und Job-Updates, sobald sie passieren.

## Wie die Verbindung funktioniert

Die Desktop-App macht sich in deinem lokalen Netzwerk bekannt, damit das Smartphone sie finden kann, und der QR-Code trägt die Details, die das Smartphone für eine sichere Verbindung braucht. Alles bleibt in deinem lokalen Netzwerk — der Companion spricht direkt mit deinem Rechner, nicht über irgendeinen Cloud-Dienst.

Weil es auf dem lokalen Netzwerk basiert, müssen beide Geräte füreinander erreichbar sein. Falls das Koppeln nicht klappt:

- Stelle sicher, dass beide Geräte im **selben WLAN** sind (und dass das Netzwerk Clients nicht voneinander isoliert).
- Achte darauf, dass die Desktop-App beim Scannen **läuft**.
- Öffne den Kopplungsbildschirm erneut, um den QR-Code aufzufrischen, und versuche erneut zu scannen.

## Was du sehen wirst

Sobald gekoppelt, zeigt der Companion deine Projekte und ihre Live-Job-Aktivität — du bekommst also dieselben Echtzeit-Rail-Updates, die ins Desktop-Dashboard fließen, direkt auf dein Smartphone gespielt, sobald sie eintreten. Es ist der einfachste Weg, den Moment mitzubekommen, in dem eine lang laufende Rail fertig wird.

## Gut zu wissen

- **Monitoring zuerst.** Der Companion ist dafür gedacht, Rails im Auge zu behalten, nicht dazu, den vollständigen Desktop-Workflow vom Smartphone aus zu steuern.
- **Nur lokal.** Kein Konto, kein Cloud-Relay — nur dein Rechner und dein Smartphone, in deinem Netzwerk.
- **Halte den Desktop wach.** Der Companion spiegelt eine laufende Desktop-App; geht dein Rechner in den Ruhezustand oder schließt die App, pausieren die Live-Updates, bis sie zurück ist.
