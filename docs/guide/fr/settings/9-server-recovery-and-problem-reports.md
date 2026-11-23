# Si le serveur local s’arrête {#server-recovery}

Specrails exécute sur votre ordinateur un petit serveur qui fait tourner vos projets, rails, missions et terminaux. L’application de bureau le surveille et le relance s’il s’arrête.

## Ce qui se passe quand le serveur s’arrête

- **Specrails le redémarre pour vous.** Le serveur revient à la même adresse et les fenêtres ouvertes se reconnectent seules ; la barre d’état affiche **Reconnexion…** pendant quelques secondes.
- **Un bandeau explique ce qui s’est passé** : quand le serveur s’est arrêté et pourquoi (un code de sortie ou un signal). Le travail en cours à ce moment a pu être interrompu : vérifiez son état et relancez-le si nécessaire.
- **Trois redémarrages par minute au maximum.** Si le serveur continue de s’arrêter, Specrails cesse de le redémarrer pour ne pas masquer un problème et affiche une boîte de dialogue. Choisissez **Try again** pour le démarrer maintenant, ou quittez puis rouvrez Specrails. Vos projets enregistrés restent sur le disque.
- **Le démarrage suivant l’explique aussi.** Si Specrails a été fermé pendant que le serveur était arrêté, le bandeau apparaît à la prochaine ouverture.

Choisissez **Ignorer** sur le bandeau une fois lu ; il ne réapparaîtra pas pour ces arrêts.

## Signaler un problème {#report-a-problem}

**Signaler un problème** enregistre sur votre ordinateur un ZIP qui aide à comprendre ce qui n’a pas fonctionné. Rien n’est envoyé : vous décidez de le partager, et avec qui.

Ouvrez-le depuis :

- **Signaler un problème** dans le bandeau,
- **Paramètres ▸ À propos ▸ Signaler un problème**,
- la palette de commandes (**⌘K**), en tapant *signaler un problème*.

Avant l’enregistrement, la fenêtre liste chaque fichier du rapport et affiche son contenu. Le ZIP contient exactement ce que vous voyez :

| Fichier | Contenu |
| --- | --- |
| `README.txt` | Ce qu’est le rapport et ce que contient chaque fichier |
| `system.json` | Versions de l’application et de Core, système d’exploitation, mémoire |
| `settings.json` | Réglages de l’application, sans jetons, clés, mots de passe, valeurs d’environnement ni en-têtes |
| `server.log` | Sortie du serveur en cours depuis son démarrage |
| `sidecar-stderr.log` | Sortie d’erreur récente du serveur, y compris les exécutions précédentes qui se sont arrêtées (application de bureau) |
| `desktop.log` | Quand le serveur a démarré, s’est arrêté et a été redémarré (application de bureau) |
| `crashes.json` | Chaque arrêt inattendu, avec ses dernières lignes d’erreur |
| `stalls.json` | Moments où le serveur ne répondait pas |

Les jetons, clés d’API, mots de passe, clés privées et identifiants dans les URL sont remplacés par `***` ou `[REDACTED]`, et votre dossier personnel apparaît comme `~`. Lisez tout de même les fichiers avant de les partager : un nom de projet ou de fichier que vous jugez privé peut y figurer.

## Réactivité {#responsiveness}

Le panneau **Ressources de l’app** de la barre d’état affiche aussi la **Réactivité** : combien de ralentissements il y a eu (des moments de 200 ms ou plus où l’application n’a pas pu répondre), le plus long et quand le dernier s’est produit. Des ralentissements longs et fréquents méritent un rapport de problème, qui inclut le détail technique.
