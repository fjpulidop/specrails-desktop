# Policy di sicurezza degli agenti {#agent-safety-policy}

Gli agenti di rail, loop e missioni lavorano senza chiederti conferma prima di ogni comando. Così sono veloci, ma alcune azioni sono troppo rischiose per lasciarle all’agente. Specrails controlla ogni chiamata a strumento di un agente **Claude** rispetto a una breve lista di divieti, prima che venga eseguita, e blocca quelle in lista.

## Cosa viene bloccato e perché

| Bloccato | Perché |
|---|---|
| **Push forzato** (`--force`, `--force-with-lease`, `+branch`, `--mirror`) | Riscrive la cronologia condivisa. |
| **Push sul branch di integrazione** (branch predefinito del progetto, `main` o `master`) | Il lavoro ci arriva solo tramite una pull request unita da una persona. |
| **Eliminazione di un branch remoto** | I branch vengono puliti con la consegna, non dall’agente. |
| **`git reset --hard` fuori dal branch del run** | Consentito sul branch del run, dentro il run; altrove può distruggere il lavoro altrui. |
| **Eliminazione di branch** protetti, di quello del run o fuori dal run | Per lo stesso motivo. |
| **Merge di una pull request** (`gh pr merge`) | Decidi tu cosa viene unito. |
| **Eliminazioni ricorsive fuori dal run** (`rm -rf`, `rimraf`, `find -delete`, `git clean -f`) | Si possono svuotare solo il worktree del run e le cartelle temporanee. Viene bloccata anche un’eliminazione con destinazione sconosciuta (`rm -rf "$DIR"`, `xargs rm -rf`). |
| **Lettura o scrittura di credenziali**: `~/.ssh`, `~/.aws`, `~/.gnupg`, portachiavi e archivio dei segreti di Specrails | Gli agenti non hanno mai bisogno delle tue chiavi. |
| **Modifica dei file della policy stessa** | Così un agente non può disattivarla. |

Tutto il resto funziona come prima.

## Cosa vedi

- L’agente riceve il motivo e prosegue senza quell’azione, oppure spiega di cosa ha bisogno.
- Il log del run o la missione mostra una riga **Bloccato dalla policy di Specrails** con la regola e il motivo.
- L’[audit delle azioni degli agenti](3-reviewing-a-delivery.md) registra ogni blocco (origine `policy-hook`) accanto all’azione tentata.

## Dove si applica

- Rail isolati, loop e sessioni Intent (ognuno nel proprio worktree) e missioni.
- **Solo Claude.** Codex non ha un equivalente che Specrails possa installare senza modificare la tua configurazione di Codex; per i run Codex, Specrails continua a controllare branch e consegna dopo ogni turno.
- I run che lavorano direttamente nella cartella del progetto (non isolati) non sono coperti: Specrails non scrive mai nella tua copia.
- macOS e Linux. Su Windows la policy non viene ancora installata.

## Da sapere

- È un parapetto, non una sandbox. Ferma i comandi distruttivi comuni; non rende sicuro un agente ostile.
- Se il controllo stesso fallisce, la chiamata prosegue, a meno che non somigli a qualcosa della lista: allora viene bloccata. Un controllo guasto non ferma mai tutti gli agenti.
- Per disattivarla in emergenza, avvia Specrails con `SPECRAILS_AGENT_POLICY_HOOK=false`.
