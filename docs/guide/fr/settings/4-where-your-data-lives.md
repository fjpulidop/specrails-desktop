# Où vivent vos données

En résumé : **Specrails garde vos dépôts impeccables.** Quand vous pointez l'application vers l'un de vos projets, elle ne s'y installe pas, n'éparpille pas des fichiers de configuration partout et ne réécrit rien que vous n'ayez demandé. Votre code reste le vôtre, et propre.

## Votre dépôt reste propre

Les fichiers propres à Specrails — ses bases de données, l'état par projet, les définitions d'agents, les paramètres, la télémétrie, les résumés et tout le reste de ce dont il a besoin pour fonctionner — vivent dans un unique foyer bien rangé sous votre dossier personnel :

```
~/.specrails/
```

Ce dossier est l'espace de travail privé de l'application. C'est là que résident le registre des projets, les bases de données par projet, l'outillage embarqué et tous les rouages opérationnels. Vos véritables dépôts de code ne servent jamais de décharge pour quoi que ce soit de tout cela.

Cela signifie :

- Le `.gitignore` de votre dépôt n'est **pas** réécrit par l'application.
- Votre dépôt n'est pas encombré de configs d'outils ni de répertoires d'état cachés.
- Retirer un projet de Specrails ne laisse aucun désordre derrière lui dans votre code.

Si vous avez déjà utilisé des outils qui ajoutaient discrètement des dossiers et des fichiers un peu partout dans votre projet, c'est ici une rupture assumée. Specrails est conçu pour que pointer l'application vers un dépôt soit un **non-événement** pour l'historique git de ce dépôt.

## La seule chose qui *est* commitée — et c'est voulu

Il existe exactement une exception intentionnelle, et c'est tout l'intérêt de l'outil : **vos specs OpenSpec.**

Les specs vivent dans votre dépôt, sous :

```
openspec/
```

C'est volontaire. Vos specs sont un **livrable** — un enregistrement versionné et revuable de ce que vous avez décidé de construire et pourquoi. Elles ont leur place à côté de votre code, suivies dans git, visibles dans les pull requests, partagées avec votre équipe. C'est là toute la valeur : les specs ne sont pas un brouillon jetable, elles font partie de l'histoire de votre projet.

La règle est donc simple et honnête :

- **`openspec/`** → vit dans votre dépôt, commité, par conception.
- **Tout le reste dont Specrails a besoin** → vit sous `~/.specrails/`, hors de votre chemin.

## Pourquoi ça marche ainsi

Specrails exécute l'outillage d'IA depuis son propre espace de travail privé (sous `~/.specrails/`) et ne revient dans votre véritable dépôt que pour les choses qui ont réellement besoin d'y toucher — lire votre code, et écrire les specs que vous avez demandées. L'outillage, les définitions du framework et toute la comptabilité restent dans le dossier personnel de l'application.

Le bénéfice pour vous : vous pouvez ajouter un projet, lancer des pipelines, explorer des specs et faire des essais en toute confiance, sachant que l'arborescence de travail et l'historique git de votre dépôt ne changent jamais que de la façon attendue — vos specs commitées, et le code que vos pipelines écrivent. Rien d'autre ne se glisse à l'intérieur.

## Retirer un projet

Quand vous retirez un projet de Specrails, l'application nettoie son propre état par projet sous `~/.specrails/`. Les specs déjà commitées dans votre dépôt restent là où elles doivent être — dans votre dépôt — parce qu'elles sont à vous.
