<!-- guide-revision: mission-first-v1 -->

# Relire une livraison dans l'app {#review-a-delivery}

Une livraison prête à être relue a deux vues : **Aperçu** (le verdict, les preuves et les boutons de décision) et **Modifications** (ce que la livraison a réellement changé). Ouvrez la revue avec le bouton **Relire** de la livraison, puis choisissez **Modifications**.

## Lire les modifications

La liste de fichiers à gauche montre chaque fichier modifié avec son statut (ajouté, modifié, supprimé, renommé), ses compteurs de lignes `+` et `−` et une coche une fois que vous le marquez comme vu. Le diff à droite charge un fichier à la fois : une grosse modification reste fluide. Passez de la disposition **Unifié** à **Côte à côte** ; Specrails retient votre choix. Un fichier très volumineux affiche ses premières lignes avec **Charger le diff complet du fichier** ; un fichier binaire est indiqué comme tel.

Les modifications sont mesurées depuis le point où la livraison s'est détachée de sa branche de base : ce qui a été ajouté à la base ensuite n'apparaît pas. Tant qu'une livraison n'a pas de branche combinée, vous pouvez choisir la branche de quelle spec lire.

## Notes du relecteur sur le code

Les constats du relecteur, les risques signalés et les commentaires de revue que l'exécution devait résoudre apparaissent sous la ligne concernée. Les notes qui ne désignent ni fichier ni ligne sont listées au-dessus de la liste de fichiers : rien n'est caché. Les anciennes livraisons, et les relecteurs qui n'ont pas indiqué d'endroit, affichent leurs constats dans cette liste.

## Demander à l'agent de modifier quelque chose

Sélectionnez des lignes en cliquant sur leurs numéros (Maj-clic étend la plage), choisissez **Demander une modification à l'agent** et décrivez la modification. Specrails l'enregistre comme retour de revue sur la spec, avec le fichier, la plage de lignes et le code sélectionné, et affiche un message avec un lien vers la spec. La prochaine exécution sur cette spec en tiendra compte. Pour la lancer tout de suite, utilisez **Demander des modifications** dans l'Aperçu. Il n'y a pas de fils de commentaires entre personnes ici ; discutez avec votre équipe sur GitHub.

## Ouvrir dans votre éditeur

**Ouvrir dans l'éditeur** ouvre le fichier, à la ligne sélectionnée, dans VS Code, Cursor ou un IDE JetBrains. Choisissez l'éditeur dans **Réglages → Code → Éditeur**. Le fichier s'ouvre depuis votre propre copie du projet, où la branche de la revue n'est peut-être pas extraite.

## Voir les conflits avant de fusionner {#merge-preview}

Chaque livraison qui vous attend est comparée à sa branche de base **telle qu’elle est maintenant** (le dernier `origin/<base>` récupéré), sans toucher à votre checkout : Git fusionne les deux en mémoire et rien n’est écrit dans votre dépôt. La carte du rail, le dossier de revue et le live board indiquent alors :

- **Conflit avec main dans …** : le changement ne se fusionne plus proprement ; les fichiers sont listés. Il prend l’aspect d’avertissement.
- **En collision avec le Rail N dans …** : une autre livraison en attente sur la même base modifie les mêmes lignes, donc celle qui fusionnera en second aura des conflits.
- **main a avancé de N commits depuis la création de cette branche** : la base a progressé ; pensez à mettre la branche à jour avant de décider.
- **Déjà dans main** : le changement est déjà intégré (par exemple après un squash merge).

Sur le tableau en direct, le résultat est une courte pastille (**2 conflits**, **Recoupe 1 run**, **Base avancée**) dont la phrase complète s’affiche au survol ou au focus. L’aperçu se met à jour quand une livraison change d’état ou qu’un run se termine. Quand Specrails fusionne lui-même plusieurs résultats, il fusionne d’abord ceux qui s’appliquent proprement. Git 2.38 ou plus récent est nécessaire ; avec un Git plus ancien, l’aperçu indique qu’il est indisponible.

## Choisir ce qu'il advient d'une livraison {#pr-decision}

Une exécution terminée ne vous demande qu'une chose : que faire de son résultat. La carte affiche un bouton principal pour l'étape suivante (créer la PR, la publier ou la vérifier) et, à côté, **Relire**, qui ouvre le dossier de relecture en langage clair. Tout le reste se trouve sous **Plus d'actions** :

- **Changer de branche** place la branche dans le dossier de votre projet pour que vous l'essayiez.
- **Intégrer en local** fusionne le résultat dans votre branche de base sur cet ordinateur. Pas besoin de GitHub, et vous confirmez d'abord.
- **Abandonner** supprime le résultat et sa branche. Vous confirmez d'abord.

Si une action échoue, la notification dit ce qui n'a pas pu être fait et propose **Réessayer**.

## Laisser Specrails garder la PR au vert {#pr-ci}

Après avoir créé une PR depuis une mission, la conversation propose **Surveiller et corriger la CI de la PR #N**. C'est facultatif et cela ne démarre jamais tout seul. Choisissez **Démarrer** et Specrails attend les checks de la PR, corrige ceux qui échouent, résout les conflits avec la branche de base en la fusionnant, vérifie le résultat sur votre ordinateur et pousse la correction dans la même PR, jusqu'à ce que les checks soient au vert. Vous pouvez suivre l'avancement dans le bandeau d'exécution (« En attente de la CI », « Correction des checks en échec », « Envoi de la correction dans la PR »).

Il ne fait jamais de force-push, ne réécrit jamais la branche, n'affaiblit jamais un check, et ne publie, ne fusionne ni ne ferme jamais la PR : ces décisions restent les vôtres. S'il ne peut pas terminer (les checks continuent d'échouer, un check requis ne remonte jamais, il lui faut un secret que vous seul pouvez fournir), il s'arrête et dit pourquoi. **Pas maintenant** masque la proposition pour cette livraison. Vous pouvez la lancer plus tard avec **Corriger CI / Conflits** dans **Plus d'actions** sur la carte de la PR ou sur le rail.

## Clavier

| Touche | Action |
| --- | --- |
| `j` / `k` | Fichier modifié suivant / précédent |
| `n` / `p` | Note du relecteur suivante / précédente |
| `v` | Marquer le fichier comme vu |

Les touches sont ignorées pendant que vous saisissez dans un champ. Marquer un fichier comme vu reste privé : si le fichier change dans une révision ultérieure, il affiche **Modifié depuis votre lecture** et redevient non vu.
