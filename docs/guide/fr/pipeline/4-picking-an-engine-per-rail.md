<!-- guide-revision: mission-first-v1 -->

# Choisir un fournisseur et ses capacités {#provider-capabilities}

Les réglages d'exécution appartiennent au fournisseur choisi. Un nom de modèle familier ne signifie pas que chaque fournisseur prend en charge les mêmes réglages de raisonnement, de sortie structurée ou d'approbation.

## Vérifier d'abord la disponibilité

Authentifiez la CLI du fournisseur et confirmez son statut dans Specrails. Choisissez parmi les modèles et les niveaux d'effort proposés par les contrôles de ce fournisseur. Une CLI installée peut quand même échouer si sa session, son quota ou son service distant est indisponible.

Claude et Codex ont des adaptateurs différents. Les combinaisons non prises en charge doivent échouer avant le démarrage d'un loop ; par exemple, on ne peut pas supposer qu'une étape exigeant une réponse structurée sans outils fonctionne avec tous les fournisseurs.

## Utiliser le bon niveau de contrôle

Le choix fournisseur/modèle d'un rail contrôle son exécution. Le loop Freestyle de la galerie tourne avec tous les fournisseurs CLI et moteurs locaux ; seul Claude ajoute le chat interactif dans le job. Les profils de rôles et le routage par agent dépendent du fournisseur et du workflow Core que Desktop a installé dans le projet ; examinez la configuration effective plutôt que de supposer qu'un profil modifie chaque appel.

Pour comparer des exécutions, gardez la même spec, la même révision du dépôt et les mêmes critères de vérification. Traitez séparément les coûts déclarés, estimés et indisponibles. Voir [les profils](../agents/profiles-and-the-balanced-default) et [l'usage](../insights/analytics-and-cost-tracking).

Pour un lancement depuis une mission, les étapes du loop héritent du fournisseur, du modèle et de l'effort de la mission, sauf si un agent les remplace explicitement dans l'éditeur de loop. Les réglages généraux gèrent les connexions aux fournisseurs ; l'ancien bloc des valeurs par défaut des fournisseurs et le sélecteur de rôles ne sont plus proposés.
