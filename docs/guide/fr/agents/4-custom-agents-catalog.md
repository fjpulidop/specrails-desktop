# Agents personnalisés et le catalogue

Les profils décident *quels agents s'exécutent et avec quels modèles*. Mais d'où viennent les agents eux-mêmes ? C'est tout l'objet du **catalogue d'agents**.

Ouvrez **Agents → Catalogue** dans n'importe quel projet. C'est un visualiseur en lecture seule de tous les agents disponibles pour ce projet, répartis en deux groupes :

- **Agents upstream** — les agents fournis avec `specrails-core` : le trio de base (`sr-architect`, `sr-developer`, `sr-reviewer`) et d'éventuels spécialistes comme `sr-merge-resolver`.
- **Agents personnalisés** — les agents que vous avez ajoutés vous-même, nommés `custom-*`.

Chaque entrée du catalogue indique à quoi sert l'agent et son modèle par défaut, ce qui vous permet de voir l'effectif complet avant de câbler des agents dans la chaîne d'un profil.

## Ajouter un agent personnalisé

Les rôles sont des assets natifs du fournisseur : Claude utilise
`.claude/agents/custom-<nom>.md` ; Kimi utilise
`.kimi-code/skills/custom-<nom>/SKILL.md`.

Dès que l'asset existe, il apparaît dans le catalogue de ce fournisseur et son id peut rejoindre un profil du même fournisseur. `custom-docs` correspond à `.claude/agents/custom-docs.md` pour Claude ou à `.kimi-code/skills/custom-docs/SKILL.md` pour Kimi ; les deux restent indépendants.

Parce qu'ils vivent dans votre dépôt, les agents personnalisés sont des **ressources d'équipe commitables** : commitez le fichier et toute votre équipe récupère l'agent. Cela reflète l'idée centrale qui traverse toute la section Agents —

> **Les définitions d'agents sont partagées (elles vivent dans le dépôt et voyagent avec `git`). La configuration des modèles est propre au projet (elle vit dans les profils).**

Core protège les deux formats. Kimi permet création/édition manuelle et
exécution ; Generate, Test et AI Refine échouent avant démarrage.

## Mettre un agent personnalisé au travail

Le flux typique :

1. Créez l'asset natif Claude ou le Skill Kimi avec instructions/modèle valides.
2. Vérifiez qu'il apparaît bien dans **Agents → Catalogue** sous Personnalisés.
3. Dans **Agents → Profils**, ajoutez l'agent à la chaîne d'un profil (en surchargeant éventuellement son modèle pour ce profil).
4. Ajoutez une règle de routage pour que les tâches portant les bons tags l'atteignent — ou reposez-vous sur l'ordre de la chaîne.
5. Lancez un rail avec ce profil depuis l'en-tête du rail.

## Suivre les performances des profils

La section Agents dispose aussi d'un onglet **Utilisation** — une répartition par profil du nombre de jobs lancés sous chaque profil sur une période sélectionnée. C'est un moyen rapide de confirmer que votre répartition `fast`/`max` est réellement utilisée comme vous l'aviez prévu, et de repérer le profil vers lequel votre équipe gravite.

## Récapitulatif de toute la section

- Les **agents** sont les membres spécialisés de l'équipe — le trio partagé, plus les spécialistes et vos agents personnalisés. ([Faites connaissance avec les agents](meet-the-agents))
- Les **profils** empaquettent quels agents s'exécutent, avec quels modèles, et comment les tâches sont routées — sélectionnés par rail au lancement. Le profil par défaut est le choix équilibré du quotidien. ([Profils et le défaut équilibré](profiles-and-the-balanced-default))
- Les **modèles** sont ajustés par agent, par projet, à l'intérieur des profils — construisez `fast` et `max` pour coller au travail. ([Personnaliser les modèles par agent](customizing-models-per-agent))
- **Le catalogue** montre chaque agent, et l'espace de noms `custom-*` vous permet d'agrandir l'équipe — définitions partagées, configuration propre au projet.
