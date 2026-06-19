# Les brouillons et le Contract Layer

Cette page couvre deux façons de tirer davantage de vos specs : les **brouillons** (enregistrer une idée en cours pour la reprendre plus tard) et le **Contract Layer** (un enrichissement optionnel qui rend les specs plus précises pour le pipeline IA).

## Les brouillons : enregistrer une idée en cours

Un **brouillon** est une conversation [Explore](add-spec-explore-mode.md) en cours, enregistrée comme spec. Il vous permet de vous arrêter au milieu d'une réflexion sans rien perdre, et de revenir quand vous êtes prêt.

### Enregistrer un brouillon

Pendant une conversation Explore, cliquez sur **Enregistrer comme brouillon** (disponible dès que vous avez envoyé au moins un message). L'app :

- Crée une spec au statut **Brouillon** sur votre tableau.
- Lui attribue un titre automatiquement si vous n'en avez pas défini (un court résumé de la conversation).
- La relie à la conversation, de sorte que tout l'historique de chat est préservé.

L'enregistrement est idempotent — si vous enregistrez deux fois la même conversation, le brouillon existant est mis à jour au lieu de créer un doublon.

### À quoi ressemblent les brouillons sur le tableau

Les brouillons vivent dans le même groupe actif que vos specs À faire — il n'y a pas de colonne séparée. Vous les repérez grâce à :

- Une pastille `Draft` à l'emplacement où se trouve habituellement la pastille de priorité.
- Une bordure subtilement teintée sur la carte.

Un brouillon a le droit de n'avoir *aucune priorité* — vous définissez la priorité au moment où vous le validez en spec à part entière.

### Reprendre un brouillon

Pour reprendre là où vous vous étiez arrêté :

1. Ouvrez le brouillon depuis le tableau.
2. Cliquez sur **Continuer l'édition** dans la fenêtre de détail.
3. La conversation Explore d'origine se rouvre avec tout son historique de chat, et le volet de brouillon vivant pré-rempli avec tout ce que vous aviez déjà façonné.
4. Continuez à discuter. Quand vous avez terminé, **Créer la spec** promeut le brouillon en spec à part entière (statut **À faire**, avec la priorité que vous choisissez).

### Abandonner un brouillon

Les brouillons ne sont **jamais supprimés automatiquement**. Ils ne disparaissent que lorsque vous les abandonnez explicitement, ou lorsque vous les validez vers un vrai statut. Abandonner un brouillon nettoie aussi la conversation qui lui est liée lorsque plus rien d'autre n'y fait référence.

> Astuce : quand vous n'êtes pas sûr qu'une spec vaille le coup, enregistrez-la comme brouillon et laissez-la reposer. Rouvrez-la le lendemain matin, parcourez la description, et décidez avec un regard neuf.

## Le Contract Layer : de la précision pour le pipeline

Le **Contract Layer** est un enrichissement optionnel qui ajoute un bloc structuré à la description d'une spec. Son rôle est de supprimer les devinettes pour les agents IA qui mettent en œuvre la spec — afin qu'ils réutilisent les bons noms, respectent les formes de données attendues et touchent aux bons fichiers, au lieu d'inventer les leurs.

### Ce qu'il ajoute

Le Contract Layer se compose de cinq courtes sections ajoutées à la spec :

- **Naming Contract** — les identifiants exacts (fonctions, champs, routes) que l'implémentation devrait réutiliser.
- **Data Shapes** — les payloads façon JSON impliqués.
- **State Machine** — les transitions ou états que la fonctionnalité traverse.
- **Invariants** — les propriétés qui doivent toujours rester vraies.
- **File Touch List** — les fichiers que l'implémentation est censée modifier.

Voyez-le comme remettre au pipeline un plan précis plutôt qu'une esquisse. C'est particulièrement précieux pour les specs qui s'intègrent à du code existant, où l'IA, en devinant un nom ou une forme, causerait du retravail.

### Comment l'ajouter

Le Contract Layer s'applique de trois façons :

- **Mode Quick** — activez l'interrupteur **Enrichir avec le Contract Layer** avant de générer. Votre dernier choix est mémorisé par projet. (Voir [Ajouter une spec — mode Quick](add-spec-quick-mode.md).)
- **Mode Explore** — choisissez le préréglage de contexte **Max** ou **Desktop** (qui exécutent l'enrichissement automatiquement à la validation), ou ouvrez **Réglages fins** et activez-le à la main. (Voir [Ajouter une spec — mode Explore](add-spec-explore-mode.md).)
- **Sur une spec existante** — ouvrez la fenêtre de détail de la spec et relancez l'enrichissement depuis là.

### Où il apparaît

Une fois qu'une spec dispose d'un Contract Layer, la fenêtre de détail l'affiche sous forme de bloc dépliable avec un badge du type `3/5 renseignés` — qui vous indique combien des cinq sections ont effectivement été remplies (certaines fonctionnalités n'ont tout simplement pas, par exemple, de state machine, et ces sections sont marquées comme non applicables). Dépliez-le pour lire le contrat complet ; repliez-le pour garder la description épurée.

Si l'enrichissement échoue un jour, l'app affiche une notification avec une action **Réessayer** pour le relancer.

### Est-ce que ça en vaut toujours la peine ?

Pas toujours. Pour une petite spec autonome, l'IA peut très bien la mettre en œuvre sans. Le Contract Layer prouve sa valeur sur les specs qui s'intègrent étroitement à du code existant, là où les noms et les formes exacts comptent — c'est dans ces cas que figer le contrat en amont vous épargne une série de corrections plus tard.

## Pour aller plus loin

- [Ajouter une spec — mode Explore](add-spec-explore-mode.md) — d'où viennent les brouillons.
- [Ajouter une spec — mode Quick](add-spec-quick-mode.md) — l'interrupteur Contract Layer en mode Quick.
- [Exécuter les pipelines](running-pipelines.md) — mettez une spec en œuvre une fois qu'elle est prête.
