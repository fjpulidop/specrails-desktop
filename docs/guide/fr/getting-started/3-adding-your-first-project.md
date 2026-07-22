# Ajouter votre premier projet

Un projet, c'est simplement un dossier sur votre ordinateur qui contient une base de code. Connectons-en un.

## Ouvrir la boîte de dialogue Ajouter un projet

Cliquez sur **Ajoutez votre premier projet** sur l'écran d'accueil (ou sur le bouton **Ajouter un projet** de la barre latérale gauche plus tard). Une petite boîte de dialogue apparaît.

## Renseignez les détails

**Dossier du projet** *(obligatoire)*

Indiquez à specrails le dossier qui contient votre code. Dans l'app de bureau, vous pouvez cliquer sur l'icône de dossier pour parcourir et le choisir visuellement, ou coller le chemin complet. Il doit s'agir de la racine de votre dépôt — le dossier contenant votre code et (généralement) un répertoire `.git`.

**Nom du projet** *(facultatif)*

Une étiquette conviviale affichée dans la barre latérale. Si vous le laissez vide, specrails utilise le nom du dossier.

> Une vérification rapide s'exécute en arrière-plan pour confirmer la présence des outils requis. S'il manque quelque chose d'essentiel, le bouton **Ajouter** reste désactivé et un lien **Plus d'infos** vous donne les commandes d'installation exactes.

C'est tout le formulaire — cliquez sur **Ajouter** et c'est terminé.

## Les fournisseurs d'IA sont détectés automatiquement

Vous ne choisissez plus de fournisseurs. Specrails détecte chaque CLI d'IA installé sur votre machine — **Claude**, **Codex**, **Gemini**, **Kimi** — et chaque projet peut tous les utiliser, toujours. Installez un nouveau fournisseur plus tard et il apparaît partout de lui-même la prochaine fois que vous revenez sur l'app ; pas de reconfiguration, pas de réglage par projet. Si un fournisseur est installé mais non connecté, son sélecteur affiche un badge discret *Non connecté*.

## La configuration se fait en silence

Il n'y a pas d'assistant de configuration. Dès que vous cliquez sur **Ajouter**, le projet est enregistré et apparaît dans votre barre latérale — vous pouvez l'ouvrir immédiatement. En arrière-plan, specrails assemble le workspace du projet (quelques secondes, entièrement hors ligne) : un petit point clignotant sur la ligne du projet indique que le travail est en cours, et il disparaît quand tout est prêt. Si quelque chose échoue pour un fournisseur, le projet fonctionne toujours avec les autres — un point ambre apparaît, et un clic relance l'opération.

## Ce qui est installé — et où

La configuration est délibérément **non invasive** : votre dépôt reste intact. Tous les artefacts specrails (définitions d'agents, commandes, profils, réglages locaux) vivent dans un workspace par projet sous votre répertoire personnel, lié à une installation unique et partagée du framework livrée avec l'app. Votre dépôt n'est jamais modifié — et lorsque l'app se met à jour, chaque projet reçoit automatiquement le nouveau framework, en une seule fois.

> **Vous préférez la configuration approfondie ?** L'app livre volontairement l'installation rapide par modèles. Si vous préférez le flux enrichi par IA (analyse de la base de code et personas d'agents personnalisées), vous pouvez exécuter `npx specrails-core@latest init` depuis le dossier de votre projet dans un terminal.

## Vous y êtes

Le tableau de bord du projet est disponible dès que vous cliquez sur **Ajouter**. Place à la visite — voir [La visite du tableau de bord](the-dashboard-tour).
