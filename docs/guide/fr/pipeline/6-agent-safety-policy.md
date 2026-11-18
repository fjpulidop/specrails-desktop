# Politique de sécurité des agents {#agent-safety-policy}

Les agents des rails, loops et missions travaillent sans vous demander avant chaque commande. Cela les rend rapides, mais quelques actions sont trop risquées pour être laissées à l’agent. Specrails vérifie chaque appel d’outil d’un agent **Claude** par rapport à une courte liste d’interdictions, avant son exécution, et bloque ceux qui y figurent.

## Ce qui est bloqué, et pourquoi

| Bloqué | Pourquoi |
|---|---|
| **Push forcé** (`--force`, `--force-with-lease`, `+branche`, `--mirror`) | Il réécrit l’historique partagé. |
| **Push sur la branche d’intégration** (branche par défaut du projet, `main` ou `master`) | Le travail n’y arrive que par une pull request fusionnée par une personne. |
| **Suppression d’une branche distante** | Les branches sont nettoyées avec la livraison, pas par l’agent. |
| **`git reset --hard` hors de la branche du run** | Autorisé sur la branche du run, dans le run ; ailleurs, il peut détruire le travail d’autrui. |
| **Suppression de branches** protégées, de celle du run ou hors du run | Même raison. |
| **Fusion d’une pull request** (`gh pr merge`) | C’est vous qui décidez de ce qui est fusionné. |
| **Suppressions récursives hors du run** (`rm -rf`, `rimraf`, `find -delete`, `git clean -f`) | Seuls le worktree du run et les dossiers temporaires peuvent être vidés. Une suppression dont la cible est inconnue (`rm -rf "$DIR"`, `xargs rm -rf`) est aussi bloquée. |
| **Lecture ou écriture d’identifiants** : `~/.ssh`, `~/.aws`, `~/.gnupg`, trousseaux et coffre de secrets de Specrails | Les agents n’ont jamais besoin de vos clés. |
| **Modification des fichiers de la politique elle-même** | Pour qu’un agent ne puisse pas la désactiver. |

Tout le reste fonctionne comme avant.

## Ce que vous voyez

- L’agent reçoit la raison et continue sans cette action, ou explique ce dont il a besoin.
- Le journal du run ou la mission affiche une ligne **Bloqué par la politique Specrails** avec la règle et la raison.
- L’[audit des actions des agents](3-reviewing-a-delivery.md) enregistre chaque refus (source `policy-hook`) à côté de l’action tentée.

## Où elle s’applique

- Rails isolés, loops et sessions Intent (chacun dans son propre worktree) et missions.
- **Claude uniquement.** Codex n’a pas d’équivalent que Specrails puisse installer sans modifier votre propre configuration Codex ; pour les runs Codex, Specrails continue de vérifier la branche et la livraison après chaque tour.
- Les runs qui travaillent directement dans le dossier de votre projet (non isolés) ne sont pas couverts : Specrails n’écrit jamais dans votre propre copie.
- macOS et Linux. Sous Windows, la politique n’est pas encore installée.

## Bon à savoir

- C’est un garde-fou, pas un bac à sable. Il arrête les commandes destructrices courantes ; il ne rend pas sûr un agent hostile.
- Si la vérification elle-même échoue, l’appel continue, sauf s’il ressemble à un élément de la liste : il est alors bloqué. Une vérification cassée n’arrête jamais tous les agents.
- Pour la désactiver en urgence, lancez Specrails avec `SPECRAILS_AGENT_POLICY_HOOK=false`.
