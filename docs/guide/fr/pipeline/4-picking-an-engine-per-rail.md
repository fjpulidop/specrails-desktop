# Choisir un moteur par rail

Specrails desktop traite **Claude Code**, **Codex CLI** et **Gemini CLI** comme des moteurs de premier plan. Un projet peut en avoir un, deux ou les trois installés — et lorsque plus d'un est présent, vous choisissez quel moteur exécute chaque rail. Cette page couvre le sélecteur de moteur par rail et le moment où choisir chacun.

## Quand le sélecteur apparaît

Le **sélecteur de moteur** se trouve dans l'en-tête du rail, juste à côté du contrôle de mode. Il ne s'affiche que lorsque le projet possède **plus d'un** fournisseur installé.

> **Les projets mono-fournisseur se comportent de manière strictement identique.** Si un projet n'a qu'un seul moteur, aucun sélecteur n'apparaît et rien ne change quant à la sélection du fournisseur — il s'exécute simplement sur ce moteur. Le sélecteur est purement réservé aux projets multi-fournisseurs.

Quand il apparaît, votre choix se fait **par rail et par lancement** — différents rails peuvent exécuter différents moteurs, et votre choix est mémorisé par projet (avec, par défaut, le moteur principal du projet).

## Comment choisir un moteur

1. Assurez-vous que le sélecteur de moteur du rail est visible (le projet a 2 fournisseurs ou plus).
2. Cliquez dessus et choisissez **Claude**, **Codex** ou **Gemini**.
3. Lancez le rail avec **▶ Play**.

Le moteur sélectionné exécute chaque phase du pipeline de ce rail. Si la CLI du moteur choisi n'est pas installée, le lancement échoue immédiatement — rien ne démarre. Installez la CLI manquante et réessayez.

## Les points forts de chaque moteur

Les trois exécutent les pipelines standards **Implement** et **Batch**. Voici un guide pratique pour choisir :

| Moteur | À privilégier quand… | Notes |
|--------|--------------------|-------|
| **Claude** | Vous voulez l'ensemble complet des fonctionnalités : profils d'agents, Freestyle, rapport de coût natif, le support d'outils le plus riche. Le choix par défaut pour la plupart du travail. | Le seul moteur qui prend en charge les **profils d'agents**, **Freestyle**, et quelques fonctionnalités de spec réservées à Claude (Contract Layer, SMASH). |
| **Codex** | Vous préférez la CLI Codex d'OpenAI ou vous voulez comparer les implémentations entre fournisseurs. | `codex` ≥ 0.128.0. Pas de rapport de coût natif — l'application complète le coût à partir de sa table de tarifs. Les profils ne s'appliquent pas. |
| **Gemini** | Vous voulez la CLI Gemini de Google, la télémétrie native, ou une exécution moins chère pour les specs de routine. | `gemini` ≥ 0.11.0 (définissez `GEMINI_API_KEY`). Télémétrie OTLP native. Les profils ne s'appliquent pas. |

### Les fonctionnalités réservées à Claude

Quelques éléments ne fonctionnent que sur les rails Claude — choisissez Claude si vous en avez besoin :

- **Profils d'agents** — routage de modèle par agent. Sur les rails Codex ou Gemini, l'exécution utilise toujours le mode legacy et tout profil sélectionné est **ignoré**. Le sélecteur de profil est masqué pour les moteurs non-Claude.
- **Freestyle** — le mode autonome qui contourne le pipeline. Le segment `Freestyle` et son sélecteur de modèle Haiku/Sonnet/Opus n'apparaissent que lorsque le moteur du rail est Claude.
- **Contract Layer et SMASH** — fonctionnalités de raffinement de spec réservées à Claude (ce sont des options d'Add Spec, pas des options de rail, mais la même contrainte s'applique).

Si un projet mélange les moteurs, la barre latérale droite n'affiche que les sections prises en charge par **tous** les fournisseurs installés — la section **Agents** disparaît donc entièrement sur un projet qui inclut un fournisseur non-Claude, car les profils sont spécifiques à Claude.

## Un flux de travail pratique

Les projets multi-fournisseurs brillent lorsque vous voulez **comparer** ou **optimiser les coûts** :

- **Comparer les implémentations.** Mettez la même spec sur deux rails, réglez l'un sur Claude et l'autre sur Codex, lancez les deux (entre projets, ou l'un après l'autre dans la file du même projet), puis utilisez le bouton **Comparer** sur la page Jobs pour comparer les résultats.
- **Optimiser le coût par spec.** Exécutez les specs à fort enjeu sur Claude avec un profil `max` ; exécutez les specs de nettoyage de routine sur Gemini pour économiser. Filtrez `/analytics` par moteur pour voir la répartition.
- **Définir un défaut judicieux.** Désignez votre moteur le plus utilisé comme moteur principal du projet pour que les rails l'utilisent par défaut, et ne changez par rail que lorsqu'une spec particulière demande un moteur différent.

## Points à garder en tête

- **La sélection des fournisseurs est immuable après la création du projet** (v1). Vous choisissez les fournisseurs installés au moment d'ajouter le projet ; il n'y a aucun réglage dans les Paramètres pour en ajouter ou en retirer un plus tard.
- **Le coût est toujours suivi**, même pour les moteurs sans rapport de coût natif — l'application se rabat sur une table de tarifs, de sorte que les exécutions Codex et Gemini apparaissent quand même dans les [analytics](../analytics/tracking-cost).
- **Le bouton « Open AI CLI » du terminal** propose également un sélecteur de fournisseur sur les projets multi-fournisseurs, si vous préférez piloter une CLI à la main.

## Où aller ensuite

- [Utiliser Codex](../integrations/using-codex) — installation et connexion.
- [Utiliser Gemini](../integrations/using-gemini) — installation, `GEMINI_API_KEY`, télémétrie.
- [Rails et jobs](rails-and-jobs) — la file d'attente et le flux de lancement.
- [Suivre le coût](../analytics/tracking-cost) — répartition du coût par moteur.
