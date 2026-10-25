# Recherche universelle (⌘K)

Appuyez sur **⌘K** (**Ctrl+K** sous Windows et Linux) pour chercher presque tout dans Specrails depuis un seul endroit : missions, specs, journaux de jobs, fichiers, réglages et ce guide. Saisissez une requête simple pour chercher parmi les missions, projets, specs et jobs récents comme avant, ou commencez par un **préfixe** pour ne chercher que dans une source.

## Préfixes

| Saisie | Cherche | Entrée ouvre |
| --- | --- | --- |
| `#` | Specs : titre, résumé, description, étiquettes, notes hors périmètre, addendums et commentaires. `#12` trouve la spec 12. | La spec |
| `@` | Missions : titre et contenu de la conversation. | La mission |
| `/` | Réglages (Desktop et projet) par nom ou par la façon dont vous les appelleriez. | La fenêtre de réglages sur ce bloc, visible et activé |
| `f:` | Fichiers du projet, par nom ou chemin. | Le fichier dans l’explorateur de code |
| `log:` | Journaux de jobs : commandes, noms de loops, titres de phases et diagnostics d’échec. | Le job |
| `?` | Ce guide : titres de pages et intertitres. | Le guide à cet intertitre |

Quand vous saisissez un préfixe, il devient une **pastille** dans la zone de recherche, qui ne garde que votre requête. Appuyez sur **Retour arrière** dans une zone vide (ou cliquez sur le × de la pastille) pour retirer le périmètre. Zone vide, la palette liste les préfixes sous la zone ; cliquez sur l’un d’eux pour commencer. `>` liste toujours les actions, comme avant.

## Surlignage

Les résultats montrent un court extrait autour de la première correspondance, avec le texte trouvé surligné. La recherche ignore la casse et les accents : `revision` trouve « Révision ».

## Réglages

`/` connaît les principaux blocs de réglages, dans votre langue : thème, langue, éditeur, budgets, notifications, webhooks, mises à jour, branche, environnement, télémétrie, règles et plus. Les réglages du projet sont proposés quand un projet est ouvert. Choisissez-en un : la bonne fenêtre s’ouvre sur ce bloc. Sans préfixe, une correspondance forte (trois caractères ou plus) ajoute jusqu’à trois réglages aux résultats habituels. `/budget` trouve aussi le panneau Budget (plafonds, projection, et si…), où se trouvent les plafonds hebdomadaire et mensuel. Une commande à barre comme `/implement` est listée sous les réglages, dans son propre groupe : le préfixe `/` ne la masque jamais.

## Journaux de jobs

`log:` interroge un index compact, pas la sortie brute d’une exécution : la commande, le nom du loop, les titres des phases et le diagnostic court d’une exécution échouée, bloquée ou à l’arrêt. Il ne stocke jamais de flux de tokens ni de sortie d’outils, il reste donc petit et rapide. Il est conservé par projet et contient les exécutions les plus récentes.

## Bon à savoir

- `#`, `f:` et `log:` cherchent dans le projet actif ; ouvrez d’abord un projet.
- Le périmètre des fichiers respecte les règles d’exclusion de l’explorateur de code.
- Chaque groupe n’affiche que ses meilleurs résultats ; affinez la requête pour restreindre.
