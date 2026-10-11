# Environnement du projet

Certains projets ont besoin d'un identifiant à l'exécution, comme `NODE_AUTH_TOKEN` pour des paquets npm privés. Dans **Paramètres du projet → Environnement**, ajoutez les **noms** des variables dont vos rails et vos loops ont besoin. Specrails enregistre uniquement les noms, jamais les valeurs.

## D'où viennent les valeurs

Au démarrage d'une exécution, Specrails lit chaque nom configuré dans l'environnement avec lequel il a été lancé. Si vous ouvrez Specrails depuis le Dock ou le Finder, cet environnement ne contient pas ce qu'exporte votre profil de shell : Specrails lit donc aussi les noms manquants dans votre shell de connexion (par exemple `~/.zprofile` ou `~/.zshrc`). Gardez le véritable identifiant dans votre profil de shell, pas dans le dépôt.

La vérification s'exécute en arrière-plan à l'ouverture du projet, quand vous modifiez les noms, puis régulièrement : un profil lent ne retarde donc pas vos exécutions. Les valeurs restent en mémoire pour ce projet uniquement.

## Lire les pastilles d'état

Chaque nom enregistré affiche une pastille :

| Pastille | Signification | Que faire |
|----------|---------------|-----------|
| **Héritée** | Specrails a été lancé avec la variable. | Rien. |
| **Du shell de connexion** | Specrails l'a lue dans votre shell de connexion. | Rien. |
| **Non définie** | Votre shell de connexion ne l'exporte pas. | Ajoutez un `export` dans votre profil de shell. |
| **Délai du shell dépassé** | Votre shell de connexion a mis trop de temps à démarrer. | Allégez le profil ou augmentez `SPECRAILS_LOGIN_SHELL_TIMEOUT_MS` (10 secondes par défaut). |
| **Échec de lecture du shell** | Specrails n'a pas pu lire votre shell de connexion. | Corrigez le profil ou lancez Specrails depuis un terminal. |

Survolez une pastille pour afficher l'explication. Après avoir corrigé votre profil, cliquez sur **Vérifier à nouveau** : inutile de redémarrer Specrails.

Si une exécution démarre alors qu'un nom n'est pas résolu, son journal affiche une ligne `[environment]` indiquant la variable et son état. L'exécution démarre quand même. La valeur n'apparaît jamais dans l'application, les journaux ou les outils MCP.

Sous Windows, Specrails utilise uniquement l'environnement avec lequel il a été lancé.
