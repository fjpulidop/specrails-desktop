# Profils et le défaut équilibré

Un **profil** est une recette enregistrée pour une exécution de pipeline. Il répond à trois questions au même endroit :

1. **Quels agents** participent (le trio de base, plus d'éventuels spécialistes ou agents personnalisés).
2. **Quel modèle** chaque agent utilise.
3. **Comment les tâches sont routées** vers ces agents.

Vous trouverez les profils dans la section **Agents** de n'importe quel projet (barre latérale droite → **Agents** → onglet **Profils**).

## Le défaut équilibré

Par défaut, un projet se rabat sur un profil **default** sensé. Il inclut le trio de base — `sr-architect`, `sr-developer`, `sr-reviewer` — et route chaque tâche vers le développeur via une unique règle fourre-tout. Les modèles sont équilibrés pour le travail quotidien : un modèle compétent là où ça compte, sans dégainer l'option la plus chère à chaque étape.

Si votre projet avait déjà des modèles d'agents configurés à l'ancienne (dans le frontmatter des fichiers d'agents), le bouton **Migrer** les lit et construit un profil `default` qui reproduit exactement le comportement actuel — aucune perte, rien ne change tant que vous ne décidez pas de l'ajuster.

L'essentiel à retenir : **vous n'avez pas besoin de créer un profil pour utiliser Specrails.** Le défaut fait simplement le travail. Les profils, c'est la manière d'aller plus loin.

## Comment un profil est choisi pour une exécution

Quand vous lancez un rail, Specrails choisit un profil dans cet ordre :

1. **Votre choix explicite** dans l'en-tête du rail (voir ci-dessous).
2. Votre **préférence par développeur** — un profil que vous avez marqué comme votre défaut personnel pour ce projet (il est local à vous et n'est pas commité).
3. Le profil **`default`** du projet.

Le profil est *figé en snapshot au lancement*, si bien que chaque rail d'un lot peut faire tourner un profil différent, et modifier un profil plus tard ne réécrit jamais les jobs déjà démarrés.

## Sélectionner un profil par rail

La sélection du profil se fait là où vous lancez — dans l'**en-tête du rail**, via le sélecteur de profil.

- Choisissez un profil dans le menu déroulant pour l'utiliser **pour ce lancement uniquement**.
- Utilisez l'option de persistance pour faire d'un profil le choix permanent du rail à l'avenir.

Voilà tout le flux : choisir un profil, lancer, terminé. Des rails simultanés dans un même lot peuvent chacun porter leur propre profil, si bien qu'un correctif rapide et une grosse fonctionnalité peuvent tourner côte à côte avec des configurations différentes.

## Quand la section Agents reste silencieuse

Les profils sont séparés par fournisseur. Claude et Kimi prennent en charge
profils/rôles ; Codex et Gemini utilisent le mode legacy. Dans un projet
mixte, un même nom ne traverse jamais Claude/Kimi. Kimi permet les rôles
manuels, mais génération, smoke test et AI Refine d'Agent Studio échouent
avant démarrage. Kimi exige `specrails-core` 4.12.0 ou plus récent.

## Pour aller plus loin

- [Personnaliser les modèles par agent](customizing-models-per-agent) — construisez des profils `fast` et `max`.
- [Agents personnalisés et le catalogue](custom-agents-catalog) — visualisez et étendez l'équipe.
