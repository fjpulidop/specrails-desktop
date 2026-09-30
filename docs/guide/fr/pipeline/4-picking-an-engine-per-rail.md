# Choisir un moteur par rail

## Quand le sélecteur apparaît

Le **sélecteur de moteur** se trouve dans l'en-tête du rail, juste à côté du contrôle de mode. Il ne s'affiche que lorsque le projet possède **plus d'un** fournisseur installé.

> **Les projets mono-fournisseur se comportent de manière strictement identique.** Si un projet n'a qu'un seul moteur, aucun sélecteur n'apparaît et rien ne change quant à la sélection du fournisseur — il s'exécute simplement sur ce moteur. Le sélecteur est purement réservé aux projets multi-fournisseurs.

Quand il apparaît, votre choix se fait **par rail et par lancement** — différents rails peuvent exécuter différents moteurs, et votre choix est mémorisé par projet (avec, par défaut, le moteur principal du projet).

## Comment choisir un moteur

Le moteur sélectionné exécute chaque phase du pipeline de ce rail. Si la CLI du moteur choisi n'est pas installée, le lancement échoue immédiatement — rien ne démarre. Installez la CLI manquante et réessayez.

## Les points forts de chaque moteur

Les quatre exécutent **Implement** :

| Moteur | À privilégier quand… | Notes |
|--------|--------------------|-------|
| **Claude** | Vous avez besoin du coût natif, de l'interaction persistante ou de politiques d'outils strictes. | Profils, Freestyle et transforms structurés. |
| **Codex** | Vous préférez la CLI Codex d'OpenAI ou vous voulez comparer les implémentations entre fournisseurs. | `codex` ≥ 0.128.0. Pas de rapport de coût natif — l'application complète le coût à partir de sa table de tarifs. Les profils ne s'appliquent pas. |

## Un flux de travail pratique

Les projets multi-fournisseurs brillent lorsque vous voulez **comparer** ou **optimiser les coûts** :

- **Comparer les implémentations.** Mettez la même spec sur deux rails, réglez l'un sur Claude et l'autre sur Codex, lancez les deux (entre projets, ou l'un après l'autre dans la file du même projet), puis utilisez le bouton **Comparer** sur la page Jobs pour comparer les résultats.
- **Définir un défaut judicieux.** Désignez votre moteur le plus utilisé comme moteur principal du projet pour que les rails l'utilisent par défaut, et ne changez par rail que lorsqu'une spec particulière demande un moteur différent.

## Points à garder en tête

- **La sélection des fournisseurs est immuable après la création du projet** (v1). Vous choisissez les fournisseurs installés au moment d'ajouter le projet ; il n'y a aucun réglage dans les Paramètres pour en ajouter ou en retirer un plus tard.
- **Le bouton « Open AI CLI » du terminal** propose également un sélecteur de fournisseur sur les projets multi-fournisseurs, si vous préférez piloter une CLI à la main.

## Où aller ensuite

- [Utiliser Codex](../integrations/using-codex) — installation et connexion.
- [Rails et jobs](rails-and-jobs) — la file d'attente et le flux de lancement.
- [Suivre le coût](../analytics/tracking-cost) — répartition du coût par moteur.
