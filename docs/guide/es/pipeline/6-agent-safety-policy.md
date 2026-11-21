# Política de seguridad de los agentes {#agent-safety-policy}

Los agentes de rails, loops y misiones trabajan sin preguntarte antes de cada comando. Así van rápido, pero hay unas pocas acciones demasiado arriesgadas para dejarlas en manos del agente. Specrails comprueba cada llamada a herramienta de un agente **Claude** contra una lista corta de prohibiciones, antes de que se ejecute, y bloquea las que están en la lista.

## Qué se bloquea y por qué

| Se bloquea | Por qué |
|---|---|
| **Push forzado** (`--force`, `--force-with-lease`, `+rama`, `--mirror`) | Reescribe historia compartida. |
| **Push a la rama de integración** (la rama por defecto del proyecto, `main` o `master`) | El trabajo llega ahí solo mediante una pull request que fusiona una persona. |
| **Borrar una rama remota** | Las ramas se limpian con la entrega, no las borra el agente. |
| **`git reset --hard` fuera de la rama de la ejecución** | Se permite en la rama de la ejecución dentro de la ejecución; en cualquier otro sitio puede destruir trabajo ajeno. |
| **Borrar ramas** protegidas, la de la propia ejecución o fuera de la ejecución | Por lo mismo. |
| **Fusionar una pull request** (`gh pr merge`) | Lo que se fusiona lo decides tú. |
| **Borrados recursivos fuera de la ejecución** (`rm -rf`, `rimraf`, `find -delete`, `git clean -f`) | Solo se pueden vaciar el worktree de la ejecución y las carpetas temporales. También se bloquea un borrado cuyo destino no se puede saber (`rm -rf "$DIR"`, `xargs rm -rf`). |
| **Leer o escribir credenciales**: `~/.ssh`, `~/.aws`, `~/.gnupg`, llaveros y el almacén de secretos de Specrails | Los agentes nunca necesitan tus claves. |
| **Cambiar los ficheros de la propia política** | Para que un agente no pueda desactivarla. |

Todo lo demás funciona como siempre.

## Qué ves

- El agente recibe el motivo y sigue sin esa acción, o explica lo que necesita.
- El log de la ejecución o la misión muestra una fila **Bloqueado por la política de Specrails** con la regla y el motivo.
- La [auditoría de acciones de los agentes](3-reviewing-a-delivery.md) registra cada bloqueo (origen `policy-hook`) junto a la acción intentada.

## Dónde se aplica

- Rails aislados, loops y sesiones de Intent (cada uno en su propio worktree) y misiones.
- **Solo Claude.** Codex no tiene un equivalente que Specrails pueda instalar sin cambiar tu propia configuración de Codex; en las ejecuciones de Codex, Specrails sigue comprobando la rama y la entrega después de cada turno.
- Las ejecuciones que trabajan directamente en la carpeta de tu proyecto (sin aislar) no están cubiertos: Specrails nunca escribe en tu propia copia.
- macOS y Linux. En Windows la política aún no se instala.

## Conviene saber

- Es una barandilla, no un sandbox. Frena los comandos destructivos habituales; no vuelve seguro a un agente hostil.
- Si la propia comprobación falla, la llamada sigue adelante, salvo que parezca algo de la lista: entonces se bloquea. Una comprobación rota nunca detiene a todos los agentes.
- Para desactivarla en una emergencia, arranca Specrails con `SPECRAILS_AGENT_POLICY_HOOK=false`.
