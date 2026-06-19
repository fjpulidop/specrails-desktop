# Qu'est-ce que specrails

Bienvenue dans **specrails** — une application de bureau qui transforme un assistant de codage IA en une véritable équipe de développement qui travaille sur *vos* projets, sur *votre* machine.

Au lieu de copier-coller des prompts dans tous les sens, vous décrivez ce que vous voulez sous la forme d'une **spec**, et specrails la fait passer dans un pipeline de développement complet — conception, construction, relecture et livraison de la modification — pendant que vous regardez tout se dérouler en direct.

## Le développement IA piloté par les specs

Le cœur de specrails repose sur une idée simple : **la meilleure façon d'obtenir du bon code d'une IA, c'est de partir d'une spec claire.**

Une *spec*, c'est une description courte et structurée d'un seul morceau de travail — une fonctionnalité, un correctif, un refactoring. Vous pouvez en rédiger une en quelques secondes, ou la façonner au fil d'un chat guidé qui pose les bonnes questions et la rédige pour vous. Chaque spec devient un **ticket** sur le tableau de votre projet, tout comme une tâche dans n'importe quel outil de suivi.

À partir de là, vous confiez la spec au pipeline et vous laissez l'IA faire le gros du travail.

## Le pipeline : Architect → Developer → Reviewer → Ship

Quand vous lancez une spec, specrails la fait passer par quatre étapes, chacune jouée par un agent IA spécialisé :

1. **Architect** — lit votre spec et le code environnant, puis planifie la modification : quels fichiers toucher, quelle forme doit prendre la solution.
2. **Developer** — écrit le code lui-même, en suivant le plan.
3. **Reviewer** — vérifie le travail pour la justesse et la qualité, et repère les problèmes avant vous.
4. **Ship** — finalise la modification pour qu'elle soit prête à être commitée.

Vous voyez chaque étape au moment où elle s'exécute, avec des logs en direct diffusés directement depuis l'IA. Rien n'est caché — si quelque chose dérape, vous verrez exactement où.

## Les projets

Tout dans specrails s'organise autour des **projets**. Un projet est simplement un dossier sur votre ordinateur qui contient une base de code. Vous pouvez ajouter autant de projets que vous le souhaitez et basculer de l'un à l'autre instantanément — chacun conserve ses propres specs, son historique de jobs, ses analytics et ses paramètres.

Specrails ne touche jamais à du code que vous ne lui avez pas demandé de toucher. Il travaille à l'intérieur de votre dépôt existant, et vous gardez le contrôle de ce qui finit par être commité.

## Choisissez votre fournisseur d'IA

Specrails fonctionne avec les principales CLI de codage IA :

- **Claude** (Claude Code)
- **Codex** (Codex CLI)
- **Gemini** (Gemini CLI)

Choisissez celui que vous utilisez déjà — ou installez-en plusieurs et choisissez selon la tâche. Un projet peut tourner sur un seul fournisseur ou sur plusieurs à la fois, vous n'êtes donc jamais enfermé.

## Pourquoi vous allez l'adorer

- **De la vitesse sans le chaos** — les specs gardent l'IA concentrée, vous obtenez donc des modifications utiles plutôt que des suppositions tous azimuts.
- **Une visibilité totale** — des logs en direct, une vue claire du pipeline et des analytics par projet vous montrent exactement ce qui s'est passé et ce que ça a coûté.
- **Votre machine, votre code** — tout tourne en local sur votre vrai dépôt.
- **Tout au même endroit** — specs, jobs, chat, un terminal intégré et le suivi des coûts, le tout dans une seule fenêtre.

Prêt à vous lancer ? La suite : [Installation et premier lancement](installing-and-first-run).
