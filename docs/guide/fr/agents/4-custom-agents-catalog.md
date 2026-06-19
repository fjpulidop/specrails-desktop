# Agents personnalisés et le catalogue

Les profils décident *quels agents s'exécutent et avec quels modèles*. Mais d'où viennent les agents eux-mêmes ? C'est tout l'objet du **catalogue d'agents**.

Ouvrez **Agents → Catalogue** dans n'importe quel projet. C'est un visualiseur en lecture seule de tous les agents disponibles pour ce projet, répartis en deux groupes :

- **Agents upstream** — les agents fournis avec `specrails-core` : le trio de base (`sr-architect`, `sr-developer`, `sr-reviewer`) et d'éventuels spécialistes comme `sr-merge-resolver`.
- **Agents personnalisés** — les agents que vous avez ajoutés vous-même, nommés `custom-*`.

Chaque entrée du catalogue indique à quoi sert l'agent et son modèle par défaut, ce qui vous permet de voir l'effectif complet avant de câbler des agents dans la chaîne d'un profil.

## Ajouter un agent personnalisé

Les agents personnalisés sont de simples fichiers Markdown dans votre dépôt, sous `.claude/agents/`, nommés `custom-<quelque-chose>.md`. Le fichier contient les instructions de l'agent (son system prompt) et un petit en-tête frontmatter qui inclut un `model:` par défaut.

Dès que le fichier existe dans le projet, il apparaît dans le catalogue comme agent personnalisé, et vous pouvez ajouter son id à la chaîne d'agents de n'importe quel profil (et y router des tâches). L'id doit correspondre au nom du fichier — une entrée `custom-docs` correspond à `.claude/agents/custom-docs.md`.

Parce qu'ils vivent dans votre dépôt, les agents personnalisés sont des **ressources d'équipe commitables** : commitez le fichier et toute votre équipe récupère l'agent. Cela reflète l'idée centrale qui traverse toute la section Agents —

> **Les définitions d'agents sont partagées (elles vivent dans le dépôt et voyagent avec `git`). La configuration des modèles est propre au projet (elle vit dans les profils).**

L'espace de noms `custom-*` est réservé et protégé : les commandes `init` et `update` de `specrails-core` ne touchent jamais à `.claude/agents/custom-*.md`, si bien que vos agents personnalisés survivent intacts aux mises à jour de core. (La même protection couvre les fragments contribués par les plugins, comme `custom-serena.md`.)

## Mettre un agent personnalisé au travail

Le flux typique :

1. Rédigez `.claude/agents/custom-<nom>.md` avec des instructions et un modèle par défaut.
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
