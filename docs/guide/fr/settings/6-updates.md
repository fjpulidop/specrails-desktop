# Mises à jour {#updates}

Specrails tient à jour deux choses : l'application **Specrails Desktop** elle-même et le framework **specrails-core** utilisé par vos projets. Les deux se trouvent dans **Paramètres ▸ Mises à jour**.

## Canal de mise à jour

Choisissez à quel rythme vous recevez les nouvelles versions :

- **Dernière** (par défaut) : chaque version dès sa sortie. Vous obtenez les nouveautés et les correctifs en premier.
- **Stable** : uniquement les versions restées au moins une semaine sur Dernière avec une CI verte, puis promues par les mainteneurs. À choisir si votre équipe préfère des mises à jour moins nombreuses et bien testées.

Le canal s'applique à l'application et à specrails-core. Si specrails-core n'a pas encore de version stable, Core suit Dernière et la carte Core vous l'indique.

Sur Stable, si aucune version n'a encore été promue, **Rechercher des mises à jour** vous le signale au lieu de proposer une version de Dernière.

## Comment arrivent les mises à jour

- **Specrails Desktop** vérifie au lancement puis toutes les 6 heures. Quand une mise à jour est disponible, un petit bouton **Mise à jour** apparaît dans la barre d'état dès que l'application est inactive depuis environ 30 secondes, jamais par-dessus une fenêtre ou une boîte de dialogue ouverte. Cliquez dessus pour ouvrir la carte de mise à jour : téléchargez, installez et redémarrez depuis celle-ci. **Ignorer** saute cette version. Vous pouvez aussi cliquer sur **Rechercher des mises à jour** ici ; la carte s'affiche alors directement dans les Réglages.
- **specrails-core** ne se met jamais à jour tout seul. Cliquez sur **Rechercher des mises à jour** dans la carte Core, puis sur **Mettre à jour**. Vos projets passent au nouveau framework sans redémarrer l'application.

## Bon à savoir

- Passer de Dernière à Stable ne vous fait jamais revenir en arrière. Vous restez sur votre version jusqu'à ce que Stable la rattrape.
- Chaque mise à jour est signée et vérifiée avant installation, sur les deux canaux.

## Quand du travail est en cours

La carte de mise à jour vérifie ce qu’un redémarrage arrêterait. S’il reste des tours de mission ou des exécutions en cours, elle le dit et propose :

- **Installer quand rien ne tourne** : la carte attend et redémarre d’elle-même dès que le dernier tour ou la dernière exécution se termine.
- **Redémarrer maintenant** : redémarre quand même. Le travail interrompu vous est reproposé après le redémarrage.

## Après un redémarrage

Si Specrails se ferme, redémarre pour une mise à jour ou s’arrête de façon inattendue pendant que du travail tourne, le lancement suivant affiche **Reprendre là où vous vous étiez arrêté** : les missions qui étaient en plein tour et les exécutions mises en pause par le redémarrage, chacune avec une case à cocher. Rien ne reprend tout seul. Les missions continuent dans leur propre session (avec une courte note signalant le redémarrage) ; les exécutions utilisent leur Reprendre habituel. **Pas maintenant** écarte la liste ; les exécutions en pause restent dans la boîte de réception. Échap ou un clic à l’extérieur la masquent seulement : elle revient au démarrage suivant.

C’est la seule fenêtre qui s’ouvre d’elle-même au lancement. Si l’application s’est aussi arrêtée de façon inattendue, l’explication apparaît dans une barre en haut de la fenêtre (elle ne vous bloque jamais). Lors d’une première installation, la visite de la plateforme attend un lancement sans ni l’une ni l’autre.
