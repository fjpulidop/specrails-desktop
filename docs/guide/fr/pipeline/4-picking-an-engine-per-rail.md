# Choisir un moteur par rail

Specrails desktop traite **Claude Code**, **Codex CLI**, **Gemini CLI** et
**Kimi Code** comme des moteurs de premier plan. Toute combinaison compatible
peut être installée.

## Quand le sélecteur apparaît

Le **sélecteur de moteur** se trouve dans l'en-tête du rail, juste à côté du contrôle de mode. Il ne s'affiche que lorsque le projet possède **plus d'un** fournisseur installé.

> **Les projets mono-fournisseur se comportent de manière strictement identique.** Si un projet n'a qu'un seul moteur, aucun sélecteur n'apparaît et rien ne change quant à la sélection du fournisseur — il s'exécute simplement sur ce moteur. Le sélecteur est purement réservé aux projets multi-fournisseurs.

Quand il apparaît, votre choix se fait **par rail et par lancement** — différents rails peuvent exécuter différents moteurs, et votre choix est mémorisé par projet (avec, par défaut, le moteur principal du projet).

## Comment choisir un moteur

1. Assurez-vous que le sélecteur de moteur du rail est visible (le projet a 2 fournisseurs ou plus).
2. Cliquez dessus et choisissez **Claude**, **Codex**, **Gemini** ou **Kimi**.
3. Lancez le rail avec **▶ Play**.

Le moteur sélectionné exécute chaque phase du pipeline de ce rail. Si la CLI du moteur choisi n'est pas installée, le lancement échoue immédiatement — rien ne démarre. Installez la CLI manquante et réessayez.

## Les points forts de chaque moteur

Les quatre exécutent **Implement** et **Batch** :

| Moteur | À privilégier quand… | Notes |
|--------|--------------------|-------|
| **Claude** | Vous avez besoin du coût natif, de l'interaction persistante ou de politiques d'outils strictes. | Profils, Freestyle et transforms structurés. |
| **Codex** | Vous préférez la CLI Codex d'OpenAI ou vous voulez comparer les implémentations entre fournisseurs. | `codex` ≥ 0.128.0. Pas de rapport de coût natif — l'application complète le coût à partir de sa table de tarifs. Les profils ne s'appliquent pas. |
| **Gemini** | Vous voulez la CLI Gemini de Google, la télémétrie native, ou une exécution moins chère pour les specs de routine. | `gemini` ≥ 0.11.0 (définissez `GEMINI_API_KEY`). Télémétrie OTLP native. Les profils ne s'appliquent pas. |
| **Kimi** | Vous voulez Kimi agentic pour Implement, Batch, Freestyle ou loops sans Decider. | `kimi` ≥ 0.27.0 externe ; profils/rôles, effort K3 seulement ; tokens/coût indisponibles. |

### Différences de capacité

Claude et Kimi prennent en charge profils et Freestyle ; Codex/Gemini
utilisent le mode legacy. Kimi refuse Loop Decider et les transforms
pure-output listés dans le [guide Kimi](../../../kimi.md). Les profils
Claude/Kimi restent séparés.

## Un flux de travail pratique

Les projets multi-fournisseurs brillent lorsque vous voulez **comparer** ou **optimiser les coûts** :

- **Comparer les implémentations.** Mettez la même spec sur deux rails, réglez l'un sur Claude et l'autre sur Codex, lancez les deux (entre projets, ou l'un après l'autre dans la file du même projet), puis utilisez le bouton **Comparer** sur la page Jobs pour comparer les résultats.
- **Optimiser le coût par spec.** Exécutez les specs à fort enjeu sur Claude avec un profil `max` ; exécutez les specs de nettoyage de routine sur Gemini pour économiser. Filtrez `/analytics` par moteur pour voir la répartition.
- **Définir un défaut judicieux.** Désignez votre moteur le plus utilisé comme moteur principal du projet pour que les rails l'utilisent par défaut, et ne changez par rail que lorsqu'une spec particulière demande un moteur différent.

## Points à garder en tête

- **La sélection des fournisseurs est immuable après la création du projet** (v1). Vous choisissez les fournisseurs installés au moment d'ajouter le projet ; il n'y a aucun réglage dans les Paramètres pour en ajouter ou en retirer un plus tard.
- **Les métriques disponibles sont suivies.** Kimi ne fournit ni tokens ni
  coût USD autoritatifs ; ces champs restent vides.
- **Le bouton « Open AI CLI » du terminal** propose également un sélecteur de fournisseur sur les projets multi-fournisseurs, si vous préférez piloter une CLI à la main.

## Où aller ensuite

- [Utiliser Codex](../integrations/using-codex) — installation et connexion.
- [Utiliser Gemini](../integrations/using-gemini) — installation, `GEMINI_API_KEY`, télémétrie.
- [Utiliser Kimi](../../../kimi.md) — installation et matrice complète.
- [Rails et jobs](rails-and-jobs) — la file d'attente et le flux de lancement.
- [Suivre le coût](../analytics/tracking-cost) — répartition du coût par moteur.
