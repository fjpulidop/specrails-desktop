# Faites connaissance avec les agents

Quand vous lancez un rail **Implement**, Specrails ne confie pas votre spec à une seule IA en croisant les doigts. Il fait tourner une petite équipe d'*agents* spécialisés, chacun avec une mission précise, dans un ordre bien pensé. Cette page vous présente qui compose cette équipe et le rôle de chacun.

## Le trio de base

Chaque exécution du pipeline s'appuie sur ces trois agents — ils en sont la colonne vertébrale, et un projet ne peut pas lancer de rail sans eux.

| Agent | Rôle | Ce qu'il fait |
|-------|------|--------------|
| **sr-architect** | Le planificateur | Lit votre spec, inspecte la base de code et produit un plan d'implémentation concret — quels fichiers toucher, quelle forme prend le changement, à quoi faire attention. Il réfléchit avant que quiconque n'écrive du code. |
| **sr-developer** | Le bâtisseur | Reprend le plan de l'architecte et écrit réellement le code : nouveaux fichiers, modifications, tests. C'est ici que votre spec se transforme en un vrai diff. |
| **sr-reviewer** | Le critique | Valide le travail du développeur au regard de la spec et du plan, repère les régressions et fait machine arrière quand quelque chose ne va pas. C'est le contrôle qualité avant que le changement soit considéré comme terminé. |

Voyez cela comme une boucle **conception → construction → relecture**, exactement celle qu'une équipe humaine soigneuse suivrait. Chaque agent transmet son résultat au suivant : le développeur ne travaille jamais à l'aveugle, et le relecteur a toujours l'intention de départ pour s'y référer.

## Les agents spécialistes

Au-delà du trio, un projet peut inclure des **agents spécialistes** optionnels qui prennent en charge des types de travail bien précis. Le plus courant que vous croiserez est :

- **sr-merge-resolver** — un agent utilitaire qui aide à démêler les conflits de merge et à concilier les modifications qui se chevauchent. Il est optionnel : les profils ne l'incluent que si vous le souhaitez, et il ne bloque jamais le pipeline en son absence.

Les spécialistes fonctionnent sur la base du volontariat. Un nouveau projet démarre avec le seul trio ; vous ajoutez des spécialistes (et vos propres **agents personnalisés** — voir [Agents personnalisés et le catalogue](custom-agents-catalog)) quand le workflow d'un projet l'exige.

## Comment les tâches atteignent le bon agent

Au sein d'une exécution, le travail est *routé*. Une tâche porte des tags, et les règles de routage d'un profil envoient les tâches taguées vers l'agent le mieux placé pour s'en occuper — avec une règle fourre-tout finale qui dirige tout le reste vers le développeur. Vous n'avez pas à vous en préoccuper pour un usage normal ; la configuration par défaut route tout de manière sensée dès le départ. Quand vous serez prêt à orienter certains types de travail vers certains agents, consultez [Personnaliser les modèles par agent](customizing-models-per-agent).

## Une idée importante, dès le départ

La *définition* de chaque agent — ses instructions, sa personnalité, ce qu'il a le droit de faire — est **partagée**. Elle vit dans des fichiers (`.claude/agents/<id>.md`) qui voyagent avec votre dépôt, si bien que toute votre équipe fait tourner le même architecte, le même relecteur.

Ce qui est **propre à chaque projet**, c'est la *configuration* qui se superpose : quel modèle chaque agent utilise, et quelle combinaison d'agents vous choisissez pour un rail donné. C'est précisément à cela que servent les profils — et c'est l'objet de la page suivante.

## Pour aller plus loin

- [Profils et le défaut équilibré](profiles-and-the-balanced-default) — comment la configuration de l'équipe est empaquetée et sélectionnée.
- [Personnaliser les modèles par agent](customizing-models-per-agent) — ajustez coût et qualité.
