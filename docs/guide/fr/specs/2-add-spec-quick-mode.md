# Ajouter une spec — mode Quick

Le mode Quick, c'est pour quand vous savez déjà ce que vous voulez. Vous tapez votre idée, l'IA écrit la spec complète, et elle atterrit sur votre tableau au statut **À faire**. Aucun aller-retour — vous décrivez et c'est parti.

## Créer une spec en mode Quick

Pour créer une spec rapidement :

1. Sur le Dashboard, cliquez sur **Ajouter** (le bouton Plus de la barre d'outils du SpecsBoard).
2. Choisissez le mode **Quick**.
3. Tapez votre idée dans le champ de texte — une phrase ou un paragraphe, ce qui la capture le mieux.
4. Cliquez pour générer.

Pendant que la spec est rédigée, un petit toast dans le coin affiche le nom du projet, un extrait de votre idée et le **temps écoulé** (« Génération… 0:12 »). Une fois terminé, le toast bascule sur « Généré en <durée> » avec une action **Voir** qui vous emmène directement à votre nouvelle spec.

C'est tout le déroulé. Tout ce qui suit n'est qu'un réglage fin optionnel.

## Ce que vous pouvez ajuster

**Modèle** — par défaut, l'IA choisit un modèle adapté. Vous pouvez le surcharger spec par spec depuis le sélecteur de modèle, si vous en voulez un plus rapide ou plus performant.

**Moteur** — si votre projet a plus d'un fournisseur IA installé (n'importe quelle combinaison de Claude, Codex et Gemini), un sélecteur de moteur figure en haut de la fenêtre pour choisir lequel génère cette spec. Votre choix est mémorisé par projet. Les projets à fournisseur unique ne l'affichent pas — il n'y a rien à choisir.

**Contexte** — le mode Quick s'exécute en général en un seul tour, car il n'a pas besoin de lire votre base de code pour rédiger une spec à partir de votre description. Mais un curseur de contexte lui permet de disposer de plus d'éléments :

- Au réglage le plus bas, il lit simplement votre description.
- Aux réglages plus élevés, il peut lire vos specs existantes, les specs OpenSpec de votre projet, et même l'intégralité de votre base de code avant de rédiger.

Plus vous lui donnez de contexte, plus la génération est longue (il passe en multi-tour pour pouvoir lire d'abord), mais la spec revient ancrée dans votre projet réel. Optez pour un contexte plus élevé quand la spec doit faire référence à du vrai code, à des noms de fichiers ou à un comportement existant.

**Pièces jointes** — déposez des maquettes, des briefs ou des fichiers de données dans le champ d'idée. L'IA les lit dans le cadre de la rédaction de la spec. (Les pièces jointes font aussi passer la génération en multi-tour.)

**Enrichir avec le Contract Layer** — un interrupteur qui ajoute un bloc structuré à la spec générée, pour que le pipeline en aval n'ait pas à deviner les noms ni les formes de données. C'est optionnel et désactivé par défaut ; votre dernier choix est mémorisé par projet. Voir [Les brouillons et le Contract Layer](drafts-and-contract-layer.md) pour ce qu'il apporte et quand cela en vaut la peine.

## Quand utiliser le mode Quick plutôt qu'Explore

Utilisez **Quick** quand l'idée est déjà claire dans votre tête — vous pourriez écrire la spec vous-même, vous préférez juste que l'IA le fasse. Utilisez [**Explore**](add-spec-explore-mode.md) quand vous êtes encore en pleine réflexion et que vous voulez un partenaire pour vous aider à la façonner.

Une spec créée en mode Quick est une spec tout à fait normale : vous pouvez plus tard l'ouvrir et **Continuer l'édition** dans une session Explore si elle a besoin d'être affinée.

## Pour aller plus loin

- [Ajouter une spec — mode Explore](add-spec-explore-mode.md) — pour les specs qui ont besoin d'être façonnées.
- [Les brouillons et le Contract Layer](drafts-and-contract-layer.md) — l'enrichissement Contract Layer expliqué.
- [Exécuter les pipelines](running-pipelines.md) — glissez votre nouvelle spec sur un rail et mettez-la en œuvre.
