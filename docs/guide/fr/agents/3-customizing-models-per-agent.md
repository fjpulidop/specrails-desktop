# Personnaliser les modèles par agent

La chose la plus utile que les profils vous permettent de faire, c'est de **choisir le bon modèle pour chaque étape**. Une étape de planification mérite peut-être votre modèle le plus puissant ; une étape de construction routinière sera sans doute parfaitement à l'aise avec quelque chose de plus rapide et moins cher. Les profils vous permettent d'exprimer exactement cela.

C'est ici que la distinction partagé / propre au projet porte ses fruits :

- Les *définitions* des agents restent partagées au sein de votre équipe.
- Le *modèle utilisé par chaque agent* se configure **par projet**, à l'intérieur d'un profil, et n'affecte que votre projet.

Changez un modèle et vous changez le coût et le comportement pour ce projet — sans toucher à la configuration de quiconque ni aux instructions sous-jacentes de l'agent.

## Changer le modèle utilisé par un agent

Dans **Agents → Profils**, sélectionnez un profil et ouvrez son éditeur de chaîne d'agents. Chaque agent de la chaîne dispose d'un champ modèle. Il y a aussi un modèle **orchestrateur** qui assure la coordination de haut niveau du pipeline.

Les valeurs de modèle sont des alias — pour Claude, ce sont `opus`, `sonnet` et `haiku` (du plus capable au plus rapide). Définissez l'alias souhaité par agent :

- Laissez le modèle d'un agent **vide** pour revenir au défaut propre au fichier de l'agent.
- Définissez-le explicitement pour le surcharger uniquement pour ce profil.

Enregistrez, et le prochain rail lancé avec ce profil utilisera les nouveaux modèles. Les jobs déjà en cours conservent leur snapshot.

## Créer des profils comme `fast` et `max`

Le schéma naturel consiste à avoir deux ou trois profils nommés vers lesquels vous vous tournez selon le travail :

**Un profil `fast`** — pour les petits changements à faible risque où vous voulez de la vitesse et une facture allégée :

- Architecte : un modèle intermédiaire ou rapide — le plan est simple.
- Développeur : un modèle rapide — le changement est mécanique.
- Relecteur : gardez-le solide, mais vous pouvez aussi alléger ici.

**Un profil `max`** — pour les fonctionnalités épineuses et à fort enjeu où vous voulez que chaque étape soit la plus pointue possible :

- Architecte, développeur et relecteur : votre modèle le plus puissant sur toute la ligne.

### Deux façons d'en construire un

1. **Dupliquer et ajuster** *(recommandé).* Sélectionnez votre profil `default`, **Dupliquez**-le, donnez à la copie un nom en kebab-case comme `fast` ou `max`, puis ajustez le modèle de chaque agent. Vous héritez d'une chaîne et d'un routage éprouvés et ne changez que ce que vous visez.
2. **Partir de zéro.** Créez un **profil vierge** et assemblez la chaîne vous-même. Vous devez toujours inclure le trio de base (`sr-architect`, `sr-developer`, `sr-reviewer`) — le pipeline dépend des trois — et exactement une règle de routage fourre-tout terminale, qui doit être en dernier.

Les noms de profils sont en kebab-case minuscule (par ex. `fast`, `max`, `cheap-and-cheerful`).

## Router les tâches vers des agents précis

Les **règles de routage** d'un profil décident quel agent prend en charge une tâche taguée. Chaque règle liste des tags de tâche et un agent cible ; la première règle dont les tags correspondent l'emporte, et une unique règle `default: true` en fin de liste attrape tout le reste. Seuls les agents réellement présents dans la chaîne du profil peuvent être des cibles de routage — l'éditeur l'impose.

Pour un usage quotidien, vous ne toucherez pas au routage : la règle fourre-tout envoie le travail au développeur et c'est très bien ainsi. Recourez aux règles de tags quand vous voulez, par exemple, que le travail tagué `migration` aille vers un spécialiste à la place.

## Choisir le profil au lancement

Tout cela se rejoint au lancement : dans l'en-tête du rail, choisissez `fast`, `max` ou `default` par rail. Un lot peut les mélanger — un minuscule correctif en `fast`, une grosse fonctionnalité en `max`, les deux tournant en même temps. Voir [Profils et le défaut équilibré](profiles-and-the-balanced-default) pour le flux de sélection.

## Un mot sur la sécurité

Supprimer un profil est sans danger pour le travail en cours : les jobs déjà lancés avec lui conservent leur snapshot, et les prochains lancements se rabattent simplement sur l'ordre de résolution. Expérimentez librement.

## Pour aller plus loin

- [Agents personnalisés et le catalogue](custom-agents-catalog) — ajoutez des agents à placer dans vos chaînes.
