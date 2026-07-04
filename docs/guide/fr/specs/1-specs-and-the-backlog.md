# Les specs et le backlog

Une **spec** est l'unité de travail que le pipeline IA met en œuvre. Voyez-la comme un ticket : un titre, une description de ce que vous voulez réaliser, une priorité et, en option, des labels. Quand vous lancez le pipeline, les agents IA lisent la spec et agissent à partir d'elle — une spec claire est donc l'élément le plus important pour obtenir un bon résultat.

Dans l'app, les specs sont parfois appelées **tickets** — les deux mots désignent exactement la même chose.

## Le tableau

Chaque projet s'ouvre sur son **Dashboard**, qui affiche le **SpecsBoard** — la liste de toutes les specs du projet. C'est votre backlog. C'est d'ici que vous créez de nouvelles specs, définissez leur priorité, les glissez sur un rail pour les mettre en œuvre, et suivez l'évolution de leur statut au fil du travail.

Le tableau propose deux modes d'affichage, basculables depuis un bouton de la barre d'outils et mémorisés par projet :

- **Vue post-it** (par défaut) — des tuiles façon cartes avec de courts résumés.
- **Vue liste** — des lignes compactes sur une seule ligne.

Le **sélecteur de statuts** de la barre d'outils affiche chaque statut sous forme de puce avec un compteur en direct — plus deux groupes intelligents : **Actives** (le défaut — tout ce qui bouge encore : brouillons, à faire, en cours et en révision) et **Tous** (tout, avec Terminé épinglé en bas). Votre choix est mémorisé par projet et reflété dans l'URL : un rafraîchissement ou un lien partagé restaure la vue exacte. Sur les projets connectés à Jira, un menu déroulant **statut Jira** supplémentaire apparaît, listant les *vrais* statuts du workflow du board (leurs noms bruts, p. ex. « Code Review », chacun avec son compteur en direct) regroupés sous l'état auquel ils correspondent — il se combine avec les puces de statut. Vous pouvez aussi filtrer par **label**, et trier par **Par défaut**, **Ticket #** ou **Priorité** (chacun avec un sens croissant/décroissant).

## Les statuts

Une spec traverse un petit ensemble de statuts. Le tableau donne à chacun un repère visuel cohérent, pour que vous lisiez l'état de votre backlog d'un seul coup d'œil :

| Statut | Ce que ça signifie |
|--------|---------------|
| **Brouillon** | Une idée en cours, enregistrée depuis une conversation Explore. Pas encore prête à être mise en œuvre — vous pouvez y revenir et continuer à la façonner. Affiche une pastille `Draft`. |
| **À faire** | Prête à être prise en charge. C'est là qu'atterrit une spec finalisée lors de sa création. |
| **En cours** | Le pipeline travaille actuellement dessus (un point bleu qui pulse). |
| **En révision** | Implémentée — chaque exécution terminée gare ici ses specs pour votre approbation : fusionnez la PR en brouillon ou déplacez-les vous-même (une pastille ambre). |
| **Terminé** | Approuvée — sa PR a été fusionnée, ou vous l'avez déplacée ici vous-même (une coche verte). |
| **Annulé** | Abandonnée (une croix rouge). |

Les brouillons vivent dans le même groupe actif que les specs À faire — il n'y a pas de colonne séparée pour eux — mais ils arborent une bordure subtilement teintée et une pastille `Draft` pour être facilement repérables. Voir [Les brouillons et le Contract Layer](drafts-and-contract-layer.md) pour tout savoir sur les brouillons.

## Les priorités

Toute spec non-brouillon possède une priorité : **Critique**, **Haute**, **Moyenne** ou **Basse**. La priorité est purement un outil d'organisation — elle vous aide à décider quoi mettre en œuvre ensuite et permet de trier le tableau. Vous la définissez à la création d'une spec, et vous pouvez la changer à tout moment via un clic droit sur la carte de la spec, en choisissant **Définir la priorité**.

Les brouillons sont la seule exception : un brouillon peut n'avoir *aucune* priorité, car c'est encore une idée en cours. La priorité est verrouillée au moment où vous validez le brouillon en spec à part entière.

## Créer une spec

Pour créer une spec, cliquez sur **Ajouter** (le bouton Plus de la barre d'outils du SpecsBoard). La fenêtre **Ajouter une spec** s'ouvre, avec plusieurs façons de travailler :

- **Mode Quick** — vous décrivez ce que vous voulez et l'IA écrit la spec complète en un seul coup. Voir [Ajouter une spec — mode Quick](add-spec-quick-mode.md).
- **Mode Explore** — vous échangez avec l'IA, qui vous aide à façonner la spec tour après tour. Voir [Ajouter une spec — mode Explore](add-spec-explore-mode.md).
- **Mode Raw** — ce que vous tapez est enregistré tel quel comme spec, sans aucune intervention de l'IA. À utiliser quand vous avez déjà rédigé le texte de la spec.

Le choix dépend du degré de clarté de votre idée. Vous savez exactement ce que vous voulez ? Quick. Vous êtes encore en train d'y réfléchir ? Explore. Vous avez déjà le texte ? Raw.

## Pour aller plus loin

- [Ajouter une spec — mode Quick](add-spec-quick-mode.md) — la façon la plus rapide de transformer une idée en spec.
- [Ajouter une spec — mode Explore](add-spec-explore-mode.md) — façonner une spec par la conversation.
- [Les brouillons et le Contract Layer](drafts-and-contract-layer.md) — enregistrer un travail en cours et enrichir les specs pour le pipeline.
