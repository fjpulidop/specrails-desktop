# Les specs et le backlog {#specs-backlog}

Une **spec** est l'unité de travail que le pipeline IA met en œuvre. Voyez-la comme un ticket : un titre, une description de ce que vous voulez réaliser, une priorité et, en option, des labels. Quand vous lancez le pipeline, les agents IA lisent la spec et agissent à partir d'elle — une spec claire est donc l'élément le plus important pour obtenir un bon résultat.

Dans l'app, les specs sont parfois appelées **tickets** — les deux mots désignent exactement la même chose.

## Le tableau

Chaque projet s'ouvre sur son **Dashboard**, qui affiche le **SpecsBoard** — la liste de toutes les specs du projet. C'est votre backlog. C'est d'ici que vous créez de nouvelles specs, définissez leur priorité, les glissez sur un rail pour les mettre en œuvre, et suivez l'évolution de leur statut au fil du travail.

Le tableau propose deux modes d'affichage, basculables depuis un bouton de la barre d'outils et mémorisés par projet :

- **Vue post-it** (par défaut) — des tuiles façon cartes avec de courts résumés.
- **Vue liste** — des lignes compactes sur une seule ligne.

La barre d'outils des Specs a deux rangées. La première réunit un champ de **recherche** (appuyez sur `/` pour y aller ; il cherche dans le titre, le `#numéro`, les étiquettes ou la clé Jira), un unique bouton **Filtres**, les contrôles de tri et d'affichage, et **Nouvelle spec**. La seconde rangée est le **sélecteur de statuts** : chaque statut sous forme de segment avec un compteur en direct, plus deux groupes intelligents, **Actives** (le défaut : tout ce qui bouge encore, soit brouillons, à faire, en cours et en révision) et **Tous** (tout, avec Terminé épinglé en bas). Quand la colonne est étroite, les statuts les moins utilisés se replient dans un menu **Plus**, et le statut choisi reste toujours visible. Votre choix est mémorisé par projet et reflété dans l'URL : un rafraîchissement ou un lien partagé restaure la vue exacte. **Filtres** ouvre un seul panneau avec une section par dimension : **étiquettes** (sélection multiple) et, sur les projets connectés à Jira, **epic**, **sprint** et **statut Jira** (les *vrais* statuts du workflow du board, p. ex. « Code Review », regroupés sous l'état auquel ils correspondent et combinés avec le sélecteur de statuts). Tant qu'une recherche ou un filtre restreint le board, une troisième rangée affiche chacun sous forme de puce amovible, indique « x sur y » specs et propose **Tout effacer** (qui conserve le statut choisi). Triez par **Par défaut**, **Ticket #** ou **Priorité**, chacun avec un sens croissant/décroissant.

### Sélectionner plusieurs specs

Triez en lot plutôt qu'une spec à la fois. Appuyez sur `x` sur une carte ciblée, cliquez sur une carte avec `Ctrl`/`⌘`, ou cliquez avec `Maj` pour sélectionner une plage (une plage reste dans une colonne : les specs actives ou le groupe Terminé). `Ctrl`/`⌘`+`A` sélectionne toute la colonne où vous êtes, et `Échap` efface la sélection. Chaque carte affiche une case au survol ou au focus, et les cartes sélectionnées ont une bordure mise en évidence. Aucune de ces touches n'agit pendant que vous saisissez du texte dans la recherche.

Dès qu'une spec est sélectionnée, une barre flottante apparaît en bas du tableau avec le nombre et les actions :

- **Déplacer vers** change le statut. Les specs locales reçoivent les statuts locaux ; celles qui viennent de Jira reçoivent les vrais statuts du workflow du tableau Jira et passent par la même file Jira qu'un déplacement individuel.
- **Libellé** ajoute un libellé à la sélection, ou retire un libellé que les specs portent.
- **Priorité** définit une même priorité pour toutes.
- **Ajouter à un rail** place la sélection sur un rail.
- **Tout lancer** donne à chaque spec sélectionnée son propre rail libre et les démarre en parallèle, après la même confirmation et le même contrôle du budget quotidien que *Tout lancer* des rails. Les specs qui ne peuvent pas encore être lancées (par exemple en revue sans PR ouverte) ou qui ne trouvent pas de rail libre sont ignorées et comptées dans le récapitulatif.
- **Supprimer** les envoie dans *Récemment supprimées*.
- **Effacer** (ou `Échap`) abandonne la sélection.

La suppression et les changements de statut, de libellés ou de priorité s'annulent en une seule étape : un seul message *Annuler* (ou `⌘Z`) restaure toutes les specs modifiées. Si certaines échouent, un seul message indique combien ont réussi et combien ont échoué. La sélection ne contient que des specs visibles : un filtre qui masque une spec sélectionnée la retire de la sélection.

### Vues enregistrées

Le bouton **Vues**, à côté de **Filtres**, enregistre le tableau tel qu'il est : le sélecteur de statut, les filtres, le tri et la densité (pas le texte de recherche). Choisissez **Enregistrer la vue actuelle…**, nommez-la (« Prêtes à lancer », « Sprint 42 », « En échec cette semaine ») et retrouvez-la ensuite dans le même menu. **Gérer les vues…** renomme une vue, la met à jour avec le tableau actuel, copie son lien ou la supprime. Les vues appartiennent au projet. Un lien copié (`?view=…`) applique la vue lorsqu'il est ouvert dans cette application, et la palette de commandes (`⌘K`) peut enregistrer la vue actuelle ou passer à une autre.

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

Pour créer une spec, cliquez sur **Nouvelle spec** (le bouton Plus de la barre d'outils du SpecsBoard). La fenêtre **Ajouter une spec** s'ouvre, avec plusieurs façons de travailler :

- **Mode Quick** — vous décrivez ce que vous voulez et l'IA écrit la spec complète en un seul coup. Voir [Ajouter une spec — mode Quick](add-spec-quick-mode.md).
- **Mode Explore** — vous échangez avec l'IA, qui vous aide à façonner la spec tour après tour. Voir [Ajouter une spec — mode Explore](add-spec-explore-mode.md).
- **Mode Raw** — ce que vous tapez est enregistré tel quel comme spec, sans aucune intervention de l'IA. À utiliser quand vous avez déjà rédigé le texte de la spec.

Le choix dépend du degré de clarté de votre idée. Vous savez exactement ce que vous voulez ? Quick. Vous êtes encore en train d'y réfléchir ? Explore. Vous avez déjà le texte ? Raw.

## Addenda : itérer sur une spec existante

Quand une spec a déjà du travail derrière elle — une PR en revue, une fonctionnalité fusionnée — et que vous en voulez *plus*, ne réécrivez pas sa description : cela fait dériver la spec (et synchronise la dérive vers Jira) et force la prochaine exécution à tout replanifier. Ouvrez la spec et ajoutez plutôt un **addendum** : une courte note avec un type (demande de changement, retour de revue, clarification, contrainte) et vos mots. Les addenda ouverts accompagnent automatiquement le prochain lancement de cette spec sur n'importe quelle boucle — Implement, SDD Quick, Freestyle — de sorte que l'exécution ne change que ce que vous avez demandé, et le paquet de revue signale chacun comme appliqué, partiellement appliqué ou bloqué. Si l'exécution échoue ou si vous écartez la livraison, ils reviennent d'eux-mêmes à **Ouvert**. L'agent de mission peut les ajouter pour vous quand vous lui demandez de modifier une spec existante.

## Relire une livraison : par où commencer

À la fin d'une exécution, son dossier de revue s'ouvre sur **Points à examiner** : la courte note du relecteur IA qui liste d'abord les endroits les plus risqués (élevé, puis moyen, puis faible, chacun avec un fichier et une ligne), le comportement qui change, les règles sur lesquelles le changement s'appuie, les chemins de code qu'aucun test n'exerce et les vérifications que seul un humain peut faire. Les mêmes risques, chemins non testés et vérifications figurent dans un court bloc en haut de la pull request, et la carte de mission affiche le risque principal sur une ligne. La note guide votre relecture, ce n'est pas un résultat de vérification : elle ne bloque jamais Accepter. Les exécutions faites avec un Specrails Core plus ancien n'ont pas de note et leur dossier reste identique.

## Annuler, et Supprimés récemment {#recently-deleted}

Supprimer une spec, la déplacer vers un autre statut, modifier ses étiquettes ou la retirer d'un rail se fait aussitôt : pas de « Êtes-vous sûr ? » au préalable. À la place, une notification propose **Annuler** pendant environ huit secondes, et **⌘Z** (**Ctrl+Z** sous Windows et Linux) fait de même tant que vous ne tapez pas dans un champ. L'annulation est propre à chaque projet : changer de projet ferme la fenêtre.

Une spec supprimée (comme une mission supprimée) n'est pas perdue. Elle passe dans **Réglages → Supprimés récemment**, dans les paramètres du projet, où vous pouvez la **Restaurer** pendant 30 jours ou la **Supprimer définitivement**, ce qui demande confirmation. Après 30 jours, elle est supprimée pour de bon. Abandonner un travail non poussé, fermer de force une pull request et retirer un projet demandent toujours confirmation, car ils sont irréversibles. Une spec liée à Jira se déplace toujours avec **Déplacer vers** au lieu d'être supprimée.

## La chronologie de la spec et la passation {#spec-timeline}

Ouvrez une spec et passez à l’onglet **Chronologie** pour lire toute son histoire au même endroit : les modifications et addenda, les missions qui l’ont touchée, chaque exécution avec ses phases et les actions de l’agent, les événements de la pull request et le verdict du relecteur avec ses constats. Les entrées sont regroupées par jour, les pastilles filtrent par type et chaque entrée renvoie à la mission, à l’exécution ou à la relecture dont elle provient. Les longs groupes (phases, actions de l’agent, tours de mission) sont repliés avec un compteur et se déplient sur place.

Le coût apparaît à côté de l’entrée qui l’a engendré, les deux sortes restant séparées : un montant communiqué par le fournisseur et un montant estimé d’après la grille tarifaire locale (marqué « est. »). Si un fournisseur est facturé via un forfait, la chronologie et les exports affichent des tours, jamais des dollars ; une exécution sans coût communiqué n’en affiche simplement pas.

**Exporter la passation** (le menu à côté des onglets, ou ⌘K → *Exporter la passation de #N*) produit un fichier Markdown ou une page HTML autonome avec le résumé, les décisions (addenda, clarifications, verdicts du relecteur), les statistiques du diff, le coût et ce qui reste ouvert (addenda ouverts et constats de relecture non résolus). **Copier comme description de PR** (aussi dans ⌘K) place une version plus courte en Markdown dans le presse-papiers. Les titres suivent la langue de l’application. Tout passe par le même masquage des secrets que l’audit des actions de l’agent, et la notification indique quand quelque chose a été masqué.

## Pour aller plus loin

- [Ajouter une spec — mode Quick](add-spec-quick-mode.md) — la façon la plus rapide de transformer une idée en spec.
- [Ajouter une spec — mode Explore](add-spec-explore-mode.md) — façonner une spec par la conversation.
- [Les brouillons et le Contract Layer](drafts-and-contract-layer.md) — enregistrer un travail en cours et enrichir les specs pour le pipeline.
