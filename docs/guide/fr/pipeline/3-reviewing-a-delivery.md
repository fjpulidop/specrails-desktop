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

## Clavier

| Touche | Action |
| --- | --- |
| `j` / `k` | Fichier modifié suivant / précédent |
| `n` / `p` | Note du relecteur suivante / précédente |
| `v` | Marquer le fichier comme vu |

Les touches sont ignorées pendant que vous saisissez dans un champ. Marquer un fichier comme vu reste privé : si le fichier change dans une révision ultérieure, il affiche **Modifié depuis votre lecture** et redevient non vu.
