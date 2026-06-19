# Installation et premier lancement

Installer specrails sur votre machine ne prend que quelques minutes. Voici le déroulé complet.

## 1. Télécharger et installer

Récupérez l'installateur correspondant à votre plateforme :

- **macOS (Apple Silicon)** — un fichier `.dmg`. Ouvrez-le et glissez **specrails** dans votre dossier Applications.
- **Windows** — un installateur `.exe`. Lancez-le et suivez les indications.

> **À noter sur les avertissements de sécurité macOS et Windows**
>
> - Sous **Windows**, l'installateur n'est pas encore signé, SmartScreen peut donc afficher un avertissement. Cliquez sur **Informations complémentaires → Exécuter quand même** pour continuer.
> - Sous **macOS**, l'application est signée et notariée, elle devrait donc s'ouvrir sans problème.

## 2. Ce dont vous aurez besoin (prérequis)

Specrails exécute des pipelines de développement IA en pilotant de vrais outils en ligne de commande ; quelques éléments doivent donc être disponibles. La bonne nouvelle : l'application de bureau **intègre la plupart d'entre eux pour vous** (Node.js, npm et Git sont fournis dans l'application), donc sur une machine neuve il n'y a en général rien à installer.

La seule chose que specrails ne peut pas intégrer, c'est la **CLI du fournisseur d'IA** elle-même. Il vous faudra au moins l'une de celles-ci :

- **Claude Code**
- **Codex CLI**
- **Gemini CLI**

Installez celle que vous comptez utiliser, connectez-vous une fois depuis votre terminal, et le tour est joué. Specrails détecte automatiquement les fournisseurs présents.

> Si un outil est signalé comme manquant, l'application affiche un lien **Informations complémentaires** avec des commandes d'installation à copier-coller, adaptées à votre système d'exploitation (Homebrew sur macOS, winget sur Windows, apt/dnf sur Linux). Vous pouvez relancer la vérification à tout moment, sans redémarrer.

## 3. Premier lancement — l'écran d'accueil

La première fois que vous ouvrez specrails, vous arrivez sur un **écran d'accueil** épuré. Il n'y a encore aucun projet, l'application vous invite donc à ajouter le premier.

Vous y verrez :

- Une courte description de ce que fait specrails.
- Un unique bouton **Ajouter votre premier projet**.

C'est tout l'onboarding — aucun compte à créer, aucune inscription. Specrails fonctionne entièrement sur votre machine.

Cliquez sur **Ajouter votre premier projet** et passez à [Ajouter votre premier projet](adding-your-first-project).
