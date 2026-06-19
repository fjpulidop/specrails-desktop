# Télémétrie & diagnostics du pipeline

Quand un job de pipeline ne se déroule pas comme prévu, la télémétrie vous offre un compte rendu détaillé et en coulisses de ce que la CLI d'IA a réellement fait. Elle est **désactivée par défaut** et entièrement optionnelle, projet par projet — ne l'activez que lorsque vous en avez besoin.

## De quoi s'agit-il

La télémétrie capture des signaux de diagnostic structurés (traces, métriques et logs) émis par la CLI d'IA pendant qu'elle exécute un job de pipeline. Voyez-la comme une boîte noire de vos exécutions de pipeline : minutages, usage de tokens et activité étape par étape, capturés localement pour que vous puissiez inspecter un job après coup.

Elle repose sur **OpenTelemetry**, un format ouvert et standard — vos données ne sont donc pas enfermées dans une boîte propriétaire.

## L'activer

La télémétrie se configure **par projet** :

1. Ouvrez la page **Paramètres** du projet (la route de paramètres propre au projet).
2. Repérez l'interrupteur **Télémétrie du pipeline**.
3. Activez-le.

À partir de là, les jobs de pipeline de ce projet enregistrent la télémétrie. Les autres projets ne sont pas affectés — chaque projet décide pour lui-même.

### Ce qui est couvert

La télémétrie s'applique aux **jobs de pipeline** (les exécutions de rail en file Architect → Developer → Reviewer → Ship). Les sessions interactives comme le chat et l'assistant de configuration en sont volontairement exclues — la télémétrie est conçue pour les exécutions de pipeline répétables et inspectables, pas pour les conversations ponctuelles.

## Où vivent les données

Tout reste sur votre machine, sous votre dossier personnel (`~/.specrails/`) — jamais dans votre dépôt. Les enregistrements bruts sont stockés compressés à côté de leur job, et les plus anciens sont automatiquement condensés en résumés compacts au bout d'une semaine pour garder le tout bien rangé. Vous n'avez jamais à gérer quoi que ce soit à la main.

## Exporter un bundle de diagnostic

Le plus utile que débloque la télémétrie, c'est l'**export de diagnostic** — une unique archive ZIP qui rassemble tout ce qui concerne un job, pour le dépannage ou le partage.

Lorsqu'un job a de la télémétrie enregistrée, un **bouton d'export** apparaît sur sa carte de job. Cliquez dessus pour télécharger un ZIP contenant :

- **`job-metadata.json`** — l'identité et les paramètres du job
- **`telemetry.ndjson`** — les signaux bruts enregistrés
- **`logs.txt`** — la sortie de logs capturée
- **`summary.md`** — un résumé lisible de l'exécution

Si le projet utilise des plugins, le bundle inclut aussi un instantané des plugins qui étaient actifs pour ce job.

C'est le bundle à récupérer quand vous voulez comprendre une exécution délicate, en garder une trace, ou transmettre des détails à quelqu'un qui vous aide à déboguer.

## Le désactiver

Remettez l'interrupteur en position désactivée à tout moment. Les nouveaux jobs cessent d'enregistrer immédiatement. Tout ce qui a déjà été capturé reste sur le disque jusqu'à sa compaction ou jusqu'à ce que vous supprimiez le projet — rien n'est envoyé où que ce soit ni perdu à votre insu.
