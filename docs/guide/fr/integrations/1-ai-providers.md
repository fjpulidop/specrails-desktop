<!-- guide-revision: mission-first-v1 -->

# Connecter un fournisseur d'IA {#ai-providers}

Specrails coordonne votre CLI Claude ou Codex authentifiée. L'installation du fournisseur, l'accès au compte et la facturation des modèles restent séparés de l'application.

## Connecter et vérifier

Installez la CLI souhaitée en suivant ses instructions officielles et connectez-vous avec le compte que vous comptez utiliser. Vérifiez sa disponibilité dans Specrails, puis choisissez un modèle pris en charge et les réglages de la mission ou du rail.

Une détection réussie ne garantit ni le quota ni la disponibilité du réseau pour l'appel suivant. Corrigez les erreurs d'authentification et de compatibilité avant de relancer une implémentation.

## Comprendre la frontière

L'app conserve les données du projet en local, tandis que les requêtes aux modèles et les intégrations configurées peuvent envoyer du contexte hors de votre machine. Choisissez les références et les pièces jointes à fournir en gardant cela en tête.

Les capacités diffèrent : les réglages de raisonnement, les réponses structurées, les sous-agents et le pilotage d'un tour en cours ne sont pas interchangeables d'un fournisseur à l'autre. Voir [les réglages d'exécution du fournisseur](../pipeline/picking-an-engine-per-rail) et [le pilotage](../pipeline/the-job-detail-view).

La sélection Sonnet exécute Claude Sonnet 5.5 (`claude-sonnet-5-5`). [Anthropic](https://platform.claude.com/docs/en/models/sonnet-5-5/overview).
