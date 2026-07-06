# Intégration Jira

Vous voulez que vos specs vivent sur un véritable **tableau Jira** plutôt qu'à l'intérieur de Specrails ? L'intégration Jira adosse les specs d'un projet à des tickets Jira, maintient les statuts synchronisés au fil des rails, et reste discrète le reste du temps. Chaque projet se synchronise avec **son propre** tableau Jira.

## Comment ça marche (la version courte)

Specrails agit comme une **couche de synchronisation** entre Jira et votre projet. L'idée maîtresse : votre magasin de specs local reste la référence que lit le pipeline, et Specrails se charge de le maintenir en accord avec Jira.

- Lorsque vous lancez un rail, Specrails fait passer le ticket Jira lié à **En cours**.
- Lorsqu'un job se termine, Specrails fait transitionner le ticket : en cas de succès, il passe à votre statut de **révision** mappé et n'atteint **Terminé** qu'une fois la PR de livraison fusionnée ou le résultat local accepté ; en cas d'échec, il revient à **À faire** avec un commentaire de clôture qui indique le résultat, l'id d'exécution, le coût, la durée et le changement de statut Jira.
- Si vous demandez des changements de suivi alors que le ticket Jira est déjà en révision, Specrails essaie de continuer la branche de la PR ouverte existante pour ce ticket au lieu de créer une nouvelle branche. Si votre statut de révision Jira n'est pas explicitement mappé et apparaît encore localement comme **En cours**, Specrails peut tout de même continuer la PR lorsque la clé Jira correspond à la pull request ouverte.
- Périodiquement, Specrails **interroge** Jira pour récupérer les changements effectués par quiconque sur le tableau et les répercute dans vos specs.

Toutes les écritures vers Jira passent par une file d'attente durable et résistante aux pannes : un incident Jira passager ne casse donc jamais un job — la mise à jour est simplement retentée.

## Connecter un tableau

La connexion se fait depuis la page **Réglages** d'un projet (il existe aussi une étape facultative « Configurer Jira » à la fin de l'assistant d'ajout de projet). L'assistant de connexion vous guide :

1. **Tester** — saisissez l'URL et les identifiants de votre Jira, et Specrails vérifie la connexion.
2. **Choisir un projet** — sélectionnez le projet Jira avec lequel synchroniser.
3. **Association des statuts (facultatif)** — associez les statuts de votre workflow Jira aux états de Specrails si la détection automatique a besoin d'un coup de main (voir plus bas).
4. **Connecter** — c'est fait. Vos specs reflètent désormais ce tableau.

### Authentification

Cette version utilise une authentification par **collage de jeton** — rapide, locale, et sans aucun backend impliqué :

- **Jira Cloud :** l'e-mail de votre compte plus un jeton API.
- **Jira Data Center / Server :** un Personal Access Token (PAT).

Votre jeton est stocké **chiffré sur votre propre machine** et n'en sort jamais. L'app indique uniquement si un jeton est présent, jamais le jeton lui-même.

## Association des statuts

La partie la plus délicate de toute synchronisation Jira, c'est de faire correspondre *votre* workflow aux états simples de Specrails (À faire / En cours / En relecture / Terminé, plus les variantes d'annulation). Specrails résout cela en deux niveaux :

1. **Votre association de statuts explicite**, si vous en définissez une dans l'assistant — toujours prioritaire.
2. **La détection automatique** à partir de la catégorie de chaque statut (new / in-progress / done) plus une correspondance intelligente pour les statuts de type annulation et livraison.

Lorsqu'il doit déplacer un ticket à travers un workflow comportant des transitions conditionnées, il trouve un chemin valide étape par étape et renseigne au passage les champs requis (comme une résolution). Si un statut est réellement inaccessible, l'opération est mise de côté en lettre morte et vous est remontée plutôt que d'échouer en silence — vous verrez un indicateur **dégradé** et pourrez réessayer.

## Hot-swap : activez et désactivez en toute sécurité

Le lien Jira est **par spec**, capturé au moment où vous lancez un rail — ce n'est pas un interrupteur global et tout-ou-rien sur le tableau. C'est ce qui le rend sûr à basculer :

- **Activer ou désactiver** l'intégration ne déplace jamais vos specs existantes.
- **Se déconnecter** rend à votre projet son comportement normal de specs locales.
- Les specs déjà dotées d'un lien Jira conservent leur écriture vers Jira ; celles qui n'en ont pas sont laissées tranquilles.

Vous pouvez donc expérimenter librement — activez, lancez quelques rails, désactivez — sans chambouler ni votre tableau ni vos specs locales.

## Au quotidien

Une fois connecté, la page Réglages du projet affiche une **carte de connexion** où vous pouvez :

- **Synchroniser maintenant** — forcer une interrogation immédiate au lieu d'attendre le minuteur.
- **Réessayer les lettres mortes** — relancer les écritures vers Jira restées bloquées.
- **Interrupteur hot-swap** — mettre temporairement en pause / reprendre l'intégration.
- **Se déconnecter** — détacher proprement le tableau.

Les specs adossées à Jira affichent un **badge de clé Jira** (comme `PROJ-123`) sur leur carte, et un clic renvoie au ticket. Vous recevrez aussi de petites notifications lorsqu'une synchronisation s'achève, lorsqu'un jeton d'authentification expire (pour que vous puissiez le renouveler), ou lorsque l'intégration passe en état dégradé.

## Bon à savoir

- **Interrogation, pas webhooks.** Comme Specrails s'exécute localement, il interroge Jira pour les changements entrants plutôt que de recevoir des notifications push. Les changements apparaissent dans l'intervalle d'interrogation, pas instantanément.
- **Un tableau par projet.** Des projets différents peuvent se synchroniser avec des tableaux différents ; un même projet se synchronise avec un seul.
- **Le dernier qui écrit l'emporte en cas de conflit**, pour le cas rare où deux onglets modifient le même brouillon en même temps.

## Désactiver l'intégration

Si vous souhaitez tout arrêter, il suffit de cliquer sur **Se déconnecter** depuis les Réglages. Vos specs retrouvent leur comportement purement local, et les métadonnées Jira restent simplement inutilisées — rien n'est détruit.
