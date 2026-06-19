# Ajouter votre premier projet

Un projet, c'est simplement un dossier sur votre ordinateur qui contient une base de code. Connectons-en un.

## Ouvrir la boîte de dialogue Ajouter un projet

Cliquez sur **Ajouter votre premier projet** sur l'écran d'accueil (ou plus tard sur le bouton **Ajouter un projet** dans la barre latérale gauche). Une petite boîte de dialogue apparaît.

## Renseigner les détails

**Dossier du projet** *(requis)*

Indiquez à specrails le dossier qui contient votre code. Dans l'application de bureau, vous pouvez cliquer sur l'icône de dossier pour le parcourir et le sélectionner visuellement, ou bien coller le chemin complet. Il doit s'agir de la racine de votre dépôt — le dossier qui contient votre code et (généralement) un répertoire `.git`.

**Nom du projet** *(facultatif)*

Un libellé convivial affiché dans la barre latérale. Si vous le laissez vide, specrails utilise le nom du dossier.

**Fournisseurs**

Choisissez le ou les fournisseurs d'IA que ce projet doit utiliser. Specrails vous présente ceux qu'il a détectés sur votre machine :

- 🤖 **Claude**
- ⚡ **Codex**
- ✨ **Gemini**

Les fournisseurs qu'il n'a pas trouvés sont grisés et marqués *introuvable* — installez-en un et connectez-vous, puis rouvrez la boîte de dialogue. Par défaut, chaque fournisseur disponible est présélectionné, mais vous pouvez tout désélectionner pour ne garder que celui que vous voulez. Si vous en choisissez plusieurs, le **premier** devient le fournisseur par défaut du projet ; vous pourrez choisir selon la tâche plus tard.

> Une vérification rapide tourne en arrière-plan pour confirmer que les outils requis sont présents. S'il manque quelque chose d'essentiel, le bouton **Ajouter** reste désactivé et un lien **Informations complémentaires** vous donne les commandes d'installation exactes.

Cliquez sur **Ajouter** pour continuer.

## Une configuration qui se fait en quelques secondes

Si le dossier est déjà configuré avec specrails, c'est terminé — le projet apparaît instantanément dans votre barre latérale.

S'il s'agit d'un projet vierge, un court **assistant de configuration** se lance. Il comporte trois étapes :

1. **Configurer** — confirmez les bases pour chaque fournisseur que vous avez choisi.
2. **Installer** — specrails configure le projet automatiquement. C'est l'installation *rapide* : des agents prédéfinis prêts à l'emploi, en place en quelques secondes. Vous verrez un log en direct pendant l'exécution.
3. **Terminé** — un récapitulatif qui confirme que tout est prêt.

Pour un projet multi-fournisseurs, l'installation s'exécute une fois par fournisseur, l'une après l'autre, et l'étape Terminé affiche une carte pour chacun.

## Ce qui est installé

La configuration est volontairement légère et **non intrusive**. Specrails ajoute une petite quantité de configuration à votre projet pour que le pipeline sache comment s'exécuter :

- Un dossier `.specrails/` qui contient les profils d'agents et les paramètres locaux de votre projet.
- Des définitions d'agents sous `.claude/agents/` qui alimentent le pipeline Architect → Developer → Reviewer → Ship.

C'est tout — specrails ne réécrit pas votre code source pendant la configuration, et ces fichiers peuvent être commités sans risque si vous souhaitez partager la configuration avec votre équipe.

> **Vous préférez la configuration approfondie ?** L'application propose l'installation rapide par templates à dessein. Si vous préférez le flux enrichi par l'IA (analyse de la base de code et personas d'agents personnalisés), vous pouvez exécuter `npx specrails-core@latest init` depuis le dossier de votre projet dans un terminal.

## Vous y êtes

Une fois la configuration terminée, specrails vous dépose dans le tableau de bord de votre projet. Place à la visite — voir [La visite du tableau de bord](the-dashboard-tour).
