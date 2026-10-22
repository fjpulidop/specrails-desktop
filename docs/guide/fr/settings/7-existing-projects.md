# Travailler dans un projet existant

Ces fonctions aident les runs à respecter un projet qui existe déjà : ce qu'une spec laisse de côté, les questions de l'architecte avant de planifier, les exigences qu'un test prouve vraiment, la façon de décrire l'ancien code avant de le modifier et les règles que votre équipe a déjà écrites. Chacune nécessite une version de specrails-core qui la prend en charge ; en attendant, son interrupteur est grisé avec une note pour mettre Core à jour.

## Hors périmètre

Chaque spec peut lister ce qu'elle ne change volontairement **pas**. Quick et Explore le remplissent pour vous ; dans la fenêtre de la spec il apparaît comme **Hors périmètre** sous la description, un élément par ligne, et se modifie comme n'importe quel champ. Les agents le reçoivent avec la spec à chaque lancement.

## Questions de l'architecte dans Jira

Dans **Réglages ▸ Ancrage dans les projets existants**, activez **Publier les clarifications de l'architecte dans Jira**. Quand un run s'arrête parce que l'architecte a besoin d'une réponse, ou continue sur des hypothèses, Specrails les publie en un commentaire sur l'issue Jira liée. Répondez à ce commentaire dans Jira : la réponse est ajoutée à la spec comme clarification et le prochain run de la spec la lit. Vous pouvez toujours répondre à un run en pause depuis l'application.

## Exigences démontrées

Quand un test nomme l'exigence qu'il prouve (`[spec:<capacité>/<exigence>]` dans son titre), la page de revue affiche **Exigences démontrées X/Y** : les exigences prouvées par un test réussi, celles qui n'en ont pas encore et celles que le changement a touchées. Les analyses montrent la même chose par loop. Pour faire échouer la CI quand une exigence modifiée n'a pas de test, ajoutez `specrails-core pipeline trace --check --tests-passed` après vos tests.

La bibliothèque de loops propose aussi **Balayage de dérive**, un loop en lecture seule qui compare ce que dit chaque spec avec ce que fait le code et liste chaque contradiction. Il ne modifie rien.

## Baseline au contact

Activez **Baseline au contact** pour qu'un changement qui atteint du code qu'aucune spec ne décrit commence par le décrire : des tests du comportement actuel, prouvés sur le code inchangé, et une courte spec de l'existant. La page de revue affiche **Spec créée là où le travail est passé** avec le module, les exigences et les tests, et son coût est affiché à part. Si ces tests échouent sur le code inchangé, le run s'arrête avant de modifier le module et le signale.

## Règles du projet

**Réglages ▸ Règles du projet** liste les contrôles que votre projet exécute déjà (lint, types, tests, CI) et chaque règle écrite dans des fichiers comme `CLAUDE.md` ou `AGENTS.md`, classées en :

- **Appliquée** : un contrôle la garantit déjà.
- **Automatisable** : un contrôle le pourrait. **Créer la spec** la transforme en spec en un clic.
- **Humaine uniquement** : quelqu'un doit regarder. Elles apparaissent sur chaque page de revue sous **Regard humain requis**.

Les règles que Core n'a pas encore pu classer (par exemple juste après l'ajout du projet, quand l'inventaire tourne hors ligne) apparaissent comme **Non classée** ; **Relancer l'inventaire** avec un fournisseur configuré les classe.

**Relancer l'inventaire** actualise la liste. Quand un projet n'a pas encore de commandes de vérification, les réglages de l'agent runtime proposent d'abord ces contrôles.
