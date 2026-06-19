# L'application compagnon mobile

Specrails dispose d'une application compagnon pour téléphone afin de garder un œil sur vos rails quand vous êtes loin de votre bureau — regardez les jobs s'exécuter, voyez-les se terminer et restez dans la boucle sans rester assis devant le tableau de bord.

## À quoi elle sert

Le compagnon est une surface de **supervision**. Il se connecte à votre app Specrails de bureau en cours d'exécution via votre réseau local et reflète sur votre téléphone l'activité en direct des projets et des jobs. Voyez-le comme une fenêtre d'un coup d'œil sur les mêmes rails que vous suivriez autrement sur le tableau de bord.

## Appairer votre téléphone

L'appairage repose sur un **QR code** pour ne rien avoir à saisir de fastidieux :

1. Assurez-vous que votre app Specrails de bureau est en cours d'exécution et que votre téléphone est sur le **même réseau local** (même Wi-Fi).
2. Dans l'app de bureau, ouvrez l'écran d'appairage pour afficher un QR code.
3. Dans l'app compagnon de votre téléphone, scannez ce code.
4. Le téléphone découvre l'app de bureau sur le réseau et s'y connecte.

À partir de là, le compagnon maintient une connexion en direct et diffuse les listes de projets et les mises à jour des jobs au fur et à mesure.

## Comment fonctionne la connexion

L'app de bureau s'annonce sur votre réseau local pour que le téléphone puisse la trouver, et le QR code transporte les informations dont le téléphone a besoin pour se connecter de façon sécurisée. Tout reste sur votre réseau local — le compagnon dialogue directement avec votre machine, sans passer par un quelconque service cloud.

Comme tout repose sur le réseau local, les deux appareils doivent pouvoir se joindre. Si l'appairage ne se fait pas :

- Vérifiez que les deux appareils sont sur le **même Wi-Fi** (et que le réseau n'isole pas les clients les uns des autres).
- Assurez-vous que l'app de bureau est **en cours d'exécution** au moment où vous scannez.
- Rouvrez l'écran d'appairage pour rafraîchir le QR code et réessayez de le scanner.

## Ce que vous verrez

Une fois appairé, le compagnon fait remonter vos projets et l'activité en direct de leurs jobs : vous obtenez ainsi les mêmes mises à jour de rails en temps réel que celles qui alimentent le tableau de bord de bureau — poussées vers votre téléphone dès qu'elles surviennent. C'est le moyen le plus simple de savoir au moment précis où un rail de longue durée se termine.

## À garder à l'esprit

- **La supervision d'abord.** Le compagnon est conçu pour surveiller les rails, pas pour piloter l'intégralité du workflow de bureau depuis votre téléphone.
- **Local uniquement.** Pas de compte, pas de relais cloud — votre machine et votre téléphone, sur votre réseau.
- **Gardez le bureau éveillé.** Le compagnon reflète une app de bureau en cours d'exécution ; si votre machine se met en veille ou que l'app se ferme, les mises à jour en direct se mettent en pause jusqu'à son retour.
