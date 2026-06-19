# Ajouter une spec — mode Explore

Le mode Explore, c'est une conversation. Au lieu d'écrire la spec vous-même, vous discutez de l'idée avec l'IA — elle joue les partenaires de réflexion, pose des questions, propose une structure et construit un **brouillon vivant** de la spec au fil de l'échange. Quand le résultat vous convient, vous validez le brouillon en spec à part entière.

Optez pour Explore quand l'idée n'est pas encore complètement formée, quand il y a des compromis à débattre, ou quand vous voulez que l'IA examine votre vrai code avant de figer la spec.

## Créer une spec en mode Explore

Pour façonner une spec en mode Explore :

1. Sur le Dashboard, cliquez sur **Ajouter**, puis choisissez **Explore**.
2. Tapez votre premier message — l'idée, une question, ou une pensée encore brute.
3. Lisez la réponse de l'IA et continuez à répondre. À chaque tour, elle affine sa compréhension.
4. Observez le **brouillon vivant** se mettre à jour à côté du chat — c'est la spec qui prend forme.
5. Quand le brouillon vous convient, cliquez sur **Créer la spec**.

La conversation reste dans votre historique : vous pouvez toujours y revenir pour voir comment la spec a été façonnée.

## Le brouillon vivant

Au fil de l'échange, un volet de brouillon affiche la spec dans son état actuel — titre, description, priorité, labels, critères d'acceptation. Il se réécrit à chaque tour en fonction de ce que vous avez discuté. Vous ne l'éditez pas directement ; vous le pilotez par la conversation (« en fait, mets la priorité en haute », « ajoute un critère sur la gestion des erreurs », et ainsi de suite).

C'est tout le cœur du mode Explore : vous n'êtes jamais face à un formulaire vide. Vous regardez toujours une spec réelle, qui évolue.

## Ce que l'IA voit : le curseur de contexte

Avant que l'IA ne réponde, vous décidez quelle part de votre projet elle peut voir. Un curseur de préréglages de contexte vous laisse arbitrer entre vitesse et profondeur :

| Préréglage | Ce que l'IA voit |
|--------|------------------|
| **Minimal** | Juste votre message. Le plus rapide et le moins cher. |
| **Léger** | + vos specs existantes. |
| **Standard** | + vos specs et les specs OpenSpec de votre projet. |
| **Riche** | + un accès en lecture à toute votre base de code, pour ancrer ses réponses dans du vrai code. |
| **Max** | Riche, plus une passe d'enrichissement Contract Layer à la validation. |
| **Desktop** | Max, plus les serveurs MCP de votre projet et vos propres serveurs MCP approuvés. |

Commencez bas pour un brainstorming rapide ; montez quand vous voulez que l'IA vérifie ses suggestions face à votre vrai code. Le choix est enregistré sur la conversation, il ne déborde donc pas sur les autres sessions Explore.

Si vous voulez un contrôle plus fin, cliquez sur **Réglages fins** pour basculer les options sous-jacentes à la main — y compris **Mes MCP approuvés**, qui charge les serveurs MCP que vous avez déjà approuvés localement sans ralentir la session.

## Les boutons du panneau Explore

- **Créer la spec** — promeut le brouillon vivant en spec à part entière, au statut **À faire**. (Quand vous éditez une spec existante, ce bouton affiche plutôt **Mettre à jour la spec** et applique les modifications à cette spec en place.)
- **Vérifier →** — ouvre une surcouche de vérification qui montre la spec proposée comparée à la version de référence avant validation, pour éviter toute surprise.
- **Enregistrer comme brouillon** — conserve la conversation comme ticket brouillon pour la reprendre plus tard. Disponible dès que vous avez envoyé au moins un message. Voir ci-dessous.
- **Réduire** — range la conversation sous forme de pastille dans le dock des chats réduits, en bas à gauche. Cliquez sur la pastille à tout moment pour replonger directement dans la conversation — rien n'est perdu.
- **Abandonner** — jette la conversation (avec une demande de confirmation au préalable).

## Enregistrer comme brouillon

Pas prêt à valider, mais vous ne voulez pas perdre votre réflexion ? Cliquez sur **Enregistrer comme brouillon**. La conversation devient une **spec brouillon** sur votre tableau, et le brouillon reste lié à la conversation qui le sous-tend.

Plus tard, ouvrez le brouillon depuis le tableau et cliquez sur **Continuer l'édition** — la conversation d'origine se rouvre avec tout son historique de chat intact, et vous reprenez exactement là où vous vous étiez arrêté. Les brouillons ne sont jamais supprimés automatiquement ; ils vous attendent.

C'est ce qui rend Explore sans risque pour les idées à moitié cuites : démarrez une conversation, avancez un peu, enregistrez-la comme brouillon, et revenez demain.

Pour tout savoir sur les brouillons — y compris l'enrichissement Contract Layer — voir [Les brouillons et le Contract Layer](drafts-and-contract-layer.md).

## Note multi-fournisseur

Si votre projet a plus d'un fournisseur IA installé, un sélecteur de moteur vous laisse choisir lequel pilote la conversation Explore. Les projets à fournisseur unique ne l'affichent pas.

## Pour aller plus loin

- [Les brouillons et le Contract Layer](drafts-and-contract-layer.md) — enregistrer un travail en cours et enrichir les specs pour le pipeline.
- [Ajouter une spec — mode Quick](add-spec-quick-mode.md) — quand l'idée est déjà claire.
- [Exécuter les pipelines](running-pipelines.md) — mettez votre spec en œuvre une fois qu'elle est prête.
